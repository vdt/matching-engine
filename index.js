
// builtin
var net = require('net');
var dgram = require('dgram');
var events = require('events');
var fs = require('fs');
var util = require('util');

// 3rd party
var uuid = require('node-uuid');
var carrier = require('carrier');
var Chain = require('chain');

// common
var Messenger = require('bitfloor/messenger');
var Journal = require('bitfloor/journal');
var logger = require('bitfloor/logger');
var config = require('bitfloor/config');
var time = require('bitfloor/time');

// local
var OrderBook = require('./lib/order_book').OrderBook;
var Order = require('./lib/order');

var matcher_state_dir = config.env.statedir;
var matcher_state_prefix = matcher_state_dir + '/matcher_state';

function Matcher(product_id, config) {
    this.server;
    this.config = config;
    this.product_id = product_id;

    // clear matcher state
    this.reset();
}

// matcher emits the 'process' event for testing
// see req_processor.js in lib
Matcher.prototype = new events.EventEmitter();

// recovers matcher state
// calls cb() on finish, exits the process if error
Matcher.prototype.recover = function(send_feed_msg, register_event_handlers, cb) {
    logger.info('state recovery started');

    var self = this;
    var state_file_prefix = 'matcher_state.' + self.product_id;
    var journal_filename = config.env.journaldir + '/matcher.' + self.product_id + '.log';

    Chain.exec(
        function() {
            // get all files in the matcher's state directory
            fs.readdir(matcher_state_dir, Chain.next())
        },
        function(err, files) {
            if (err) {
                logger.panic('could not read matcher state dir', err);
                process.exit(1);
            }

            var state_files = [];

            // get the files that match the prefix
            files.forEach(function(file) {
                if(file.indexOf(state_file_prefix) === 0) {
                    var num = file.match(/\.(\d+)\.json/)[1] - 0;
                    state_files.push({file: file, num: num});
                }
            });

            if (!state_files.length) {
                logger.info('No state files found! Either this is the first time starting the matcher for this product or there is a serious error');

                // always register the event handlers before calling callback
                register_event_handlers();

                if (cb)
                    cb();
                return;
            }

            // get the one with the latest state_num
            state_files.sort(function(a, b) { return b.num - a.num; });
            var state_file = state_files[0].file;

            fs.readFile(matcher_state_dir + '/' + state_file, 'utf8', Chain.next());
        },
        function(err, data) {
            if (err) {
                logger.panic('could not read matcher state file', err);
                process.exit(1);
            }

            var state = JSON.parse(data);

            // fill up the order book
            state.bids.forEach(function(order_data) {
                order_data.side = 0;
                var order = Order.parse(order_data);
                //logger.trace('adding back ' + util.inspect(order));
                self.order_book.add(order);
            });
            state.asks.forEach(function(order_data) {
                order_data.side = 1;
                var order = Order.parse(order_data);
                //logger.trace('adding back ' + util.inspect(order));
                self.order_book.add(order);
            });

            // set the other stateful fields
            self.state_num = state.state_num;
            self.output_seq = state.output_seq;
            self.ticker = state.ticker;

            logger.trace('added back data from state file, reading journal');

            // open up the journal file
            var fstream = fs.createReadStream(journal_filename);
            fstream.on('error', function(err) {
                logger.panic('could not read matcher journal', err);
                process.exit(1);
            });

            var cstream = carrier.carry(fstream);

            // register the event handlers here because messages need to be
            // sent out during replay, but not before that!
            register_event_handlers();

            // the state num in the journal (1 smaller than the saved one)
            var journal_state_num = self.state_num - 1;

            // do the replay
            var playback = false;
            cstream.on('line', function(line) {
                if (line.length) {
                    var data = JSON.parse(line);
                    if (data.type === "state" && data.payload === journal_state_num) {
                        playback = true;
                        return;
                    }

                    if (playback) {
                        //logger.trace('playing back ' + util.inspect(data));
                        var handler = self._get_handler(data, send_feed_msg);
                        if (!handler) {
                            logger.warn('no handler for message type ' + data.type);
                            return;
                        }
                        handler(data.payload);
                    }
                }
            });

            cstream.on('end', function() {
                // serious error, we have the wrong journal or it's corrupt
                if (!playback) {
                    var errmsg = 'Could not find state num ' +
                                 journal_state_num + ' in journal';
                    logger.panic(errmsg, new Error(errmsg));
                    process.exit(1);
                }

                logger.trace('state recovery successful');

                if (cb)
                    cb();
            });
        }
    );
};


/// returns a handler that affects the matcher's state
/// send_feed_msg is a function that will send a msg out
/// ev is an optional event emitter, events will not be emitted if omitted
Matcher.prototype._get_handler = function(msg, send_feed_msg, ev) {
    var self = this;
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
                user_id: order.user_id,
                price: order.price,
                size: order.size,
                fee_rate: payload.fee_rate,
                timestamp: time.timestamp()
            };
            send_feed_msg('order_status', payload);

            // add the order to the order book
            // if the order can be matched immediately, it will be
            // this should happen after the sends because it may cause fills to be sent
            self.order_book.add(order);

            // for testing only
            self.emit('process');
        },
        'cancel': function(payload) {
            var oid = payload.order_id;
            var user_id = payload.user_id;

            var result = self.order_book.remove(oid, user_id);

            // if there was an error, inform the user
            if (result && ev) {
                ev.emit('reply', {
                    type: 'cancel_reject',
                    timestamp: time.timestamp(),
                    target_id: user_id,
                    product_id: self.product_id,
                    payload: {
                        order_id: oid,
                        reject_reason: result.message,
                    }
                });
            }

            // for testing only
            self.emit('process');
        },
    };

    return msg_handlers[msg.type];
};

/// start the matcher, callback when started
Matcher.prototype.start = function(cb) {
    var self = this;
    logger.trace('starting matcher');

    var client = self.config.client;
    var feed = self.config.feed;

    var order_book = self.order_book;

    // the multicast feed channel socket
    var feed_socket = this.feed_socket = dgram.createSocket('udp4');

    var ev = new events.EventEmitter();

    // inbound message journal, initialized later
    var journal;

    // output journal for the matcher
    var journal_out = new Journal('matcher_out.' + self.product_id, false);

    // journal & send a message out on the multicast socket
    // updaters and other interested sources listen for this data
    function send_feed_msg(type, payload) {
        // avoid referencing into the feed config object for every message send
        var feed_ip = feed.ip;
        var feed_port = feed.port;

        // construct the message
        var msg = {
            type: type,
            timestamp: time.timestamp(),
            product_id: self.product_id,
            seq: self.output_seq,
            payload: payload
        };

        // journal the message before sending it
        // it's not necessary to wait for this to finish, since
        // this is just for nightly reconciliation
        // state is persisted by the input journal & state files
        journal_out.log(msg);

        // have to send buffers
        var buff = new Buffer(JSON.stringify(msg));

        // beam me up scotty!
        feed_socket.send(buff, 0, buff.length, feed_port, feed_ip, function(err) {
            if (err)
                logger.warn(err.message);
        });

        ++self.output_seq;
    }

    // writes the state to the state file
    // cb(state) when done
    function write_state(cb) {
        var state_num = self.state_num;
        var filename = matcher_state_prefix + "." + self.product_id + "." + state_num + ".json";
        journal.log({type: 'state', payload: state_num}, function(){
            var state = self.state();

            // save what the state num should be when recovering state via file
            state.state_num = state_num + 1; // TODO: jenky?

            fs.writeFile(filename, JSON.stringify(state));

            cb(state);
        });
        ++self.state_num;
    }

    function register_event_handlers() {
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
                user_id: order.user_id,
                price: order.price,
                size: order.size,
                timestamp: time.timestamp(),
            };

            send_feed_msg('order_status', payload);
        })
        // taker is the liq. taker, provider is the liq. provider
        .on('match', function(size, taker, provider) {
            var price = provider.price;
            var timestamp = time.timestamp();
            var payload = {
                id: uuid('binary').toString('hex'),
                taker_id: taker.id,
                provider_id: provider.id,
                taker_user_id: taker.user_id,
                provider_user_id: provider.user_id,
                size: size,
                price: price,
                provider_side: provider.side,
                timestamp: timestamp,
            };

            // save ticker info
            self.ticker = {
                price: price,
                size: size,
                timestamp: timestamp
            };

            send_feed_msg('match', payload);
        })
        .on('order_done', function(order) {
            var payload = {
                order_id: order.id,
                status: 'done',
                size: order.size, // need for fast cancel (hold amount calc)
                user_id: order.user_id,
                reason: (order.done) ? 'filled' : 'cancelled',
                timestamp: time.timestamp(),
            };
            send_feed_msg('order_status', payload);
        });

    }

    // matcher server setup and connection handling
    var server = this.server = net.createServer();

    function start_server(err) {
        // start up input journal only after recovery has happened
        journal = this.journal = new Journal('/matcher.' + self.product_id, false);

        // write state to file to make recovery cases easier
        write_state(function() {
            server.listen(client.port, client.ip, function() {
                logger.trace('matcher started');
                if (cb)
                    cb();
            });
        });
    }

    if (self.config.no_recover) {
        register_event_handlers();
        start_server();
    } else {
        // recover the state before accepting requests
        self.recover(send_feed_msg, register_event_handlers, start_server);
    }

    // server event handlers
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
            var handler = self._get_handler(msg, send_feed_msg, ev);

            if (!handler) {
                // state requests don't happen often so only try to handle them
                // if we don't already have a handler for the message type
                // these are special messages not intended for the matcher
                if (msg.type === 'state') {
                    write_state(function(state) {
                        ms.send({ type: 'state', payload: state });
                    });
                    return;
                }

                // if we didn't have a handler and it wasn't a sub request
                return logger.warn('no handler for message type: ' + msg.type, msg);
            }

            // wait for journal write before processing request
            // these journaled messages affect the state of the matcher
            journal.log(msg, function() {
                if (!msg.payload)
                    return logger.warn('no payload in message', msg);
                return handler(msg.payload);
            });
        });
    });
};

Matcher.prototype.stop = function(cb) {
    logger.trace('stopping matcher');
    this.order_book.removeAllListeners();

    if (typeof this.server.fd === 'number') // make sure server is running
        this.server.close();

    this.server.on('close', function() {
        logger.trace('matcher stopped');
        if (cb)
            cb();
    });

    this.feed_socket.close();
};

Matcher.prototype.state = function() {
    var state = this.order_book.state();
    state.state_num = this.state_num;
    state.output_seq = this.output_seq;
    state.ticker = this.ticker;
    return state;
};

// resets matcher's state
Matcher.prototype.reset = function() {
    this.output_seq = 1;
    this.state_num = 0;
    this.order_book = new OrderBook();
    this.ticker = {};
};

module.exports = Matcher;
