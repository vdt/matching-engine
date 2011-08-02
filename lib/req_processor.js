var Order = require('./order');

function ReqProcessor(matcher) {
    this.book = matcher.order_book;
    this._matcher = matcher;
}

ReqProcessor.prototype.process = function(msg, ev) {
    this['_' + msg['type']](msg.payload, ev);
}

ReqProcessor.prototype._order = function(order_dict, ev) {
    var order = Order.parse(order_dict);

    ev.add(order);
    this.book.add(order, ev);

    // for testing only
    this._matcher.events.emit('process');
}

ReqProcessor.prototype._cancel = function(cancel_dict, ev) {
    var oid = cancel_dict.order_id;
    var sender = cancel_dict.sender_id;

    this.book.remove(oid, sender, ev);

    // for testing only
    this._matcher.events.emit('process');
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
