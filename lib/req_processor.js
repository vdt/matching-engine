var Journal = require('../../common/journal');

var Order = require('./order');

function ReqProcessor(matcher) {
    this.book = matcher.order_book;
    this._matcher = matcher;
    this.journal = new Journal('matcher_in', false); // incoming journal
}

ReqProcessor.prototype.process = function(msg, ev) {
    this['_' + msg['type']](msg.payload, ev, msg);
}

ReqProcessor.prototype._order = function(order_dict, ev, msg) {
    var self = this;
    // wait for journal write before processing request
    this.journal.log(msg, function() {
        var order = Order.parse(order_dict);

        ev.add(order);
        self.book.add(order, ev);

        // for testing only
        self._matcher.events.emit('process');
    });
}

ReqProcessor.prototype._cancel = function(cancel_dict, ev, msg) {
    var self = this;
    // wait for journal write before processing request
    this.journal.log(msg, function() {
        var oid = cancel_dict.order_id;
        var sender = cancel_dict.sender_id;

        self.book.remove(oid, sender, ev);

        // for testing only
        self._matcher.events.emit('process');
    });
}

ReqProcessor.prototype._sub = function(dict, ev) {
    var key;
    if(dict)
        key = dict.key;
    ev.pubsub.sub(key);
}

ReqProcessor.prototype._unsub = function(dict, ev) {
    var key;
    if(dict)
        key = dict.key;
    ev.pubsub.unsub(key);
}

exports.ReqProcessor = ReqProcessor;
