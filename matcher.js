
// builtin
var net = require('net');
var dgram = require('dgram');
var events = require('events');
var fs = require('fs');

// 3rd party
var uuid = require('node-uuid');

// common
var Messenger = require('../common/messenger');
var Journal = require('../common/journal');
var logger = require('../common/logger');
var products = require('../common/products');
var config = require('../common/config');

// local
var OrderBook = require('./lib/order_book').OrderBook;
var Order = require('./lib/order');

var matcher_state_prefix = config.env.logdir + "/matcher_state";

function Matcher(config) {
    this.server;
    this.order_book;
    this.config = config;
    this.state_num = 0;
    this.output_seq = 0;
}

// matcher emits the 'process' event for testing
// see req_processor.js in lib
Matcher.prototype = new events.EventEmitter();

/// start the matcher, callback when started
Matcher.prototype.start = function(cb) {
    var self = this;
    logger.trace('starting matcher');

    var client = self.config.client;
    var feed = self.config.feed;

    var order_book = this.order_book = new OrderBook();

    // inbound message journal
    var in_journal = this.journal = new Journal('matcher_in', false);

    // event journal for the matcher
    var journal = new Journal('matcher', false);

    // the multicast feed channel socket
    var feed_socket = this.feed_socket = dgram.createSocket('udp4');

    var ev = new events.EventEmitter();

    // journal & send a message out on the multicast socket
    // updaters and other interested sources listen for this data
    function send_feed_msg(type, payload) {
        // avoid referencing into the feed config object for every message send
        var feed_ip = feed.ip;
        var feed_port = feed.port;

        // construct the message
        var msg = {
            type: type,
            timestamp: Date.now(),
            seq: self.output_seq,
            payload: payload
        };

        // journal the message before sending it
        // it's not necessary to wait for this to finish, since
        // this is just for nightly reconciliation
        // state is persisted by the input journal & state files
        journal.log(msg);

        // have to send buffers
        var buff = new Buffer(JSON.stringify(msg));

        // beam me up scotty!
        feed_socket.send(buff, 0, buff.length, feed_port, feed_ip, function(err) {
            if (err)
                logger.warn(err.message);
        });

        ++self.output_seq;
    };

    /// order book event handlers
    order_book
    .on('add_order', function(order) {
        // client has already been notofied that the order is open at the exchange
        // we can't do it here because the order may never be added to the book if it is
        // executed immediately, thus no call to event dist
        // the 'open' order status means that the order is now open on the order book
        var payload = {
            status: 'open',
            side: order.side,
            order_id: order.id,
            sender: order.sender,
            price: order.price,
            size: order.size,
            exchange_time: Date.now()
        };

        send_feed_msg('order_status', payload);
    })
    // taker is the liq. taker, provider is the liq. provider
    .on('match', function(size, taker, provider) {
        var payload = {
            id: uuid('binary').toString('hex'),
            taker_id: taker.id,
            provider_id: provider.id,
            taker_user_id: taker.sender,
            provider_user_id: provider.sender,
            size: size,
            price: provider.price,
            taker_side: taker.side,
            taker_original_limit: taker.price,
            taker_done: taker.done == true, // .done may be undefined
            provider_done: provider.done == true
        };

        send_feed_msg('match', payload);
    })
    .on('remove_order', function(order) {
        var payload = {
            order_id: order.id,
            status: 'done',
            size: order.size, // need for fast cancel (hold amount calc)
            price: order.price, // need for fast cancel (hold amount calc)
            side: order.side, // need for fast cancel (hold amount calc)
            user_id: order.sender, // need for fast cancel (hold amount update)
            reason: (order.done) ? 'filled' : 'cancelled'
        };
        send_feed_msg('order_status', payload);
    });

    // handlers for messages which will affect the matcher state
    var msg_handlers = {
        'order': function(payload) {
            var order = Order.parse(payload);

            // received order into the matcher
            // this order status is sent to indicate that the order was received
            var payload = {
                status: 'received',
                side: order.side,
                order_id: order.id,
                sender: order.sender,
                price: order.price,
                size: order.size,
                exchange_time: Date.now()
            };
            send_feed_msg('order_status', payload);

            // add the order to the order book
            // if the order can be matched immediately, it will be
            // this should happen after the sends because it may cause fills to be sent
            order_book.add(order);

            // for testing only
            self.emit('process');
        },
        'cancel': function(payload) {
            var oid = payload.order_id;
            var sender = payload.sender_id;

            var result = order_book.remove(oid, sender);

            // if there was an error, inform the user
            if (result) {
                ev.emit('reply', {
                    type: 'cancel_reject',
                    timestamp: Date.now(),
                    target_id: sender,
                    payload: {
                        order_id: oid,
                        reject_reason: result.message
                    }
                });
            }

            // for testing only
            self.emit('process');
        },
    };

    /// matcher server setup and connection handling

    var server = this.server = net.createServer();
    server.listen(client.port, client.ip, function() {
        logger.trace('matcher started');
        cb();
    });

    server.on('connection', function(socket) {
        var addr = socket.remoteAddress + ":" + socket.remotePort;
        logger.trace('accepted connection from: ' + addr);

        // the outgoing messenger for the client
        var ms = new Messenger(socket);

        function send_reply(obj) {
            ms.send(obj);
        }

        ev.on('reply', send_reply);

        socket.on('close', function() {
            logger.trace('removing send_reply handler for ' + addr);
            ev.removeListener('reply', send_reply);
        });

        ms.addListener('msg', function(msg) {
            logger.trace('got msg: ' + msg.type);

            var handler = msg_handlers[msg.type];
            if (!handler) {

                // state requests don't happen often so only try to handle them
                // if we don't already have a handler for the message type
                // these are special messages not intended for the matcher
                if (msg.type === 'state') {
                    var filename = matcher_state_prefix + "." + self.state_num + ".json";
                    in_journal.log({type: 'state', payload: self.state_num}, function(){
                        var state = self.state();
                        fs.writeFile(filename, JSON.stringify(state));
                        ms.send(state);
                    });
                    ++self.state_num;
                    return;
                }

                // if we didn't have a handler and it wasn't a sub request
                return logger.warn('no handler for message type: ' + msg.type, msg);
            }

            // wait for journal write before processing request
            // these journaled messages affect the state of the matcher
            in_journal.log(msg, function() {
                if (!msg.payload)
                    return logger.warn('no payload in message', msg);
                return handler(msg.payload);
            });
        });
    });
};

Matcher.prototype.stop = function() {
    logger.trace('stopping matcher');
    this.server.close();
    this.server.on('close', function() {
        logger.trace('matcher stopped');
    });

    this.feed_socket.close();
};

Matcher.prototype.state = function() {
    var state = this.order_book.state();
    state.state_num = this.state_num;
    state.output_seq = this.output_seq;
    return state;
};

// resets matcher's sequence numbers
Matcher.prototype.reset = function() {
    this.output_seq = 0;
    this.state_num = 0;
};

/// main

if(require.main === module) {
    // matcher configs
    var matchers = require('../common/config').matchers();

    var product_id = process.argv[2];
    if (!product_id) {
        logger.error('no product specfied');
        process.exit();
    }

    var matcher = new Matcher(matchers[product_id]);
    matcher.start(function() {
        logger.trace('matcher running for product: ' + product);
    });
}

module.exports = Matcher;
