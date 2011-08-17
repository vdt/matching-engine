var sys = require('sys');
var net = require('net');
var events = require('events');

var Messenger = require('../common/messenger');
var logger = require('../common/logger');

var OrderBook = require('./lib/order_book').OrderBook;
var ReqProcessor = require('./lib/req_processor').ReqProcessor;
var EventSender = require('./lib/event_sender').EventSender;
var PubSub = require('./lib/pub_sub').PubSub;

var PORT = 6666;

function Matcher() {
    this.server;
    this.order_book;
    this.events = new events.EventEmitter();
}

Matcher.prototype.start = function(port, cb) {
    logger.trace('Starting matcher');

    var self = this;

    var emitter = new events.EventEmitter();

    this.order_book = new OrderBook();

    var order_processor = new ReqProcessor(this);

    this.server = net.createServer();
    this.server.listen(port, 'localhost', function() {
        logger.trace('Matcher started');
        cb();
    });
    this.server.on('connection', function(socket) {
        addr = socket.remoteAddress + ":" + socket.remotePort;
        logger.trace('accepted connection from ' + addr);

        var ms = new Messenger(socket);
        var pubsub = new PubSub(ms, emitter);

        socket.on('close', function() {
            logger.trace('closing pubsub for ' + addr);
            pubsub.close();
        });

        var ev = new EventSender(pubsub);
        ms.addListener('msg', function(msg) {
            logger.trace('Got msg: ' + msg.type);
            order_processor.process(msg, ev);
        });
    });
}

Matcher.prototype.stop = function() {
    logger.trace('Stopping matcher');
    this.server.close();
    this.server.on('close', function() {
        logger.trace('Matcher stopped');
    });
}

Matcher.prototype.state = function() {
    return this.order_book.state();
}

function main() {
    var matcher = new Matcher();
    matcher.start(PORT, function() {
        console.log('server running...');
    });
}

if(require.main === module) {
    main();
}

module.exports = Matcher;
