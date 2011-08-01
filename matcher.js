var sys = require('sys');
var net = require('net');
var events = require('events');

var msgpack = require('msgpack-0.4');

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
    var emitter = new events.EventEmitter();

    this.order_book = new OrderBook();

    var order_processor = new ReqProcessor(this);
    
    this.server = net.createServer();
    this.server.listen(port, cb);
    this.server.on('connection', function(socket) {
        var ms = new msgpack.Stream(socket);
        var pubsub = new PubSub(socket, emitter);

        var ev = new EventSender(pubsub);
        ms.addListener('msg', function(msg) {
            order_processor.process(msg, ev);
        });
    });
}

Matcher.prototype.stop = function() {
    this.server.close();
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
