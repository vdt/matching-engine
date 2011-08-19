
// builtin
var net = require('net');
var dgram = require('dgram');
var events = require('events');

// 3rd party
var uuid = require('node-uuid');

// common
var Messenger = require('../common/messenger');
var Journal = require('../common/journal');
var logger = require('../common/logger').set_ident('matcher');

// local
var OrderBook = require('./lib/order_book').OrderBook;
var Order = require('./lib/order');
var EventSender = require('./lib/event_sender').EventSender;
var PubSub = require('./lib/pub_sub').PubSub;

function Matcher(config) {
    this.server;
    this.order_book;
    this.config = config;
};

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

    // outgoing matcher events go through the central event dispatcher
    // the event dispatcher emits event messages which can be picked up by
    // any interested event subscribers
    var ev = new EventSender();

    // inbound message journal
    var in_journal = this.journal = new Journal('matcher_in', false);

    // event journal for the matcher
    var journal = new Journal('matcher', false);

    // the multicast feed channel socket
    var feed_socket = this.feed_socket = dgram.createSocket('udp4');

    // send a message out on the multicast socket
    function send_feed_msg(msg) {
        // avoid referencing into the feed config object for every message send
        var feed_ip = feed.ip;
        var feed_port = feed.port;

        // have to send buffers
        var buff = new Buffer(JSON.stringify(msg));

        // beam me up scotty!
        feed_socket.send(buff, 0, buff.length, feed_port, feed_ip, function(err) {
            if (err)
                logger.warn(err.message);
        });
    };

    /// order book event handlers
    order_book
    .on('add_order', function(order) {
        // client has already been notofied that the order is open at the exchange
        // we can't do it here because the order may never be added to the book if it is
        // executed immediately, thus no call to event dist

        // also not jounraled because it has already been journaled upon being received

        // the 'open' order status means that the order is now open on the order book
        var add_order = {
            type: 'order_status',
            timestamp: Date.now(),
            payload: {
                status: 'open',
                side: order.side,
                order_id: order.id,
                sender: order.sender,
                price: order.price,
                size: order.size,
                exchange_time: Date.now()
            }
        };

        send_feed_msg(add_order);
    })
    // taker is the liq. taker, provider is the liq. provider
    .on('match', function(size, taker, provider) {
        var self = this;
        var time = Date.now();

        // write the match event to the journal
        var match_msg = {
            type: 'match',
            timestamp: time,
            payload: {
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
            }
        };

        // we don't have to wait for the journal because the incomming jounral is available
        // the outgoing journal is only used if there was a connectivity issue for updaters
        journal.log(match_msg);

        // send the match information out to the network
        // updaters and other interested sources listen for this data
        // to create feed streams
        send_feed_msg(match_msg);

        // notify clients of the match
        ev.fill(time, size, taker, false);
        ev.fill(time, size, provider, true);

        // if taker is done, we need to send a done
        // the taker will never be added to the order book so we cannot rely on the remove
        // order event to send a done or cancel message
        if (taker.done)
            ev.done(taker);
    })
    .on('remove_order', function(order) {

        // if an order was removed from the book, the match will take care of sending
        // out the corresonding done message?
        var msg = {
            type: 'order_status',
            timestamp: Date.now(),
            payload: {
                order_id: order.id,
                status: 'done',
                reason: (order.done) ? 'filled' : 'cancelled'
            }
        };

        // notify client of their done or canceled order
        if (order.done)
            ev.done(order);
        else
            ev.cancelled(order);
    });

    // handlers for messages which will affect the matcher state
    var msg_handlers = {
        'order': function(payload) {
            var order = Order.parse(payload);

            // received order into the matcher
            // this order status is sent to indicate that the order was received
            var received_order = {
                type: 'order_status',
                timestamp: Date.now(),
                payload: {
                    status: 'received',
                    side: order.side,
                    order_id: order.id,
                    sender: order.sender,
                    price: order.price,
                    size: order.size,
                    exchange_time: Date.now()
                }
            };

            // journal that we received the order
            // althought we have it in the "in" journal, this journal is for recovery
            // for updater and other database processes
            journal.log(received_order);

            send_feed_msg(received_order);

            // send an open order event to clients
            ev.open(order);

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
            if (result)
                ev.cancel_reject(oid, sender, result.message);

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
        var pubsub = new PubSub(ms);

        ev.on('event', function(sender, event) {
            return pubsub.pub(sender, event);
        });

        socket.on('close', function() {
            logger.trace('closing pubsub for ' + addr);
            pubsub.close();
        });

        ms.addListener('msg', function(msg) {
            logger.trace('got msg: ' + msg.type);

            var handler = msg_handlers[msg.type];
            if (!handler) {

                // sub requests don't happen that often so only try to handle them
                // if we don't already have a handler for the message type
                // these are special messages not intended for the matcher
                if (msg.type === 'sub') {
                    var key = (msg.payload) ? msg.payload.key : undefined;
                    return pubsub.sub(key);
                } else if (msg.type === 'unsub') {
                    var key = (msg.payload) ? msg.payload.key : undefined;
                    return pubsub.unsub(key);
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
}

Matcher.prototype.stop = function() {
    logger.trace('stopping matcher');
    this.server.close();
    this.server.on('close', function() {
        logger.trace('matcher stopped');
    });

    this.feed_socket.close();
}

Matcher.prototype.state = function() {
    return this.order_book.state();
}

/// main

if(require.main === module) {
    logger.enable_stdout_provider();

    // matcher configs
    var matchers = require('../common/config').matchers();

    var product = process.argv[2];
    if (!product) {
        logger.error('no product specfied');
        process.exit();
    }

    var matcher = new Matcher(matchers[product]);
    matcher.start(function() {
        logger.trace('matcher running for product: ' + product);
    });
}

module.exports = Matcher;
