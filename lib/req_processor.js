var Order = require('./order');

function OrderProcessor(matcher) {
    this.book = matcher.order_book;
    this._matcher = matcher;
}

OrderProcessor.prototype.process = function(msg, ev) {
    this['_' + msg['type']](msg.payload, ev);
}

OrderProcessor.prototype._order = function(order_dict, ev) {
    var order = Order.parse(order_dict);

    ev.add(order);
    this.book.add(order, ev);

    // for testing only
    this._matcher.events.emit('process');
}

OrderProcessor.prototype._cancel = function(cancel_dict, ev) {
    var oid = cancel_dict.order_id;
    var sender = cancel_dict.sender_id;

    this.book.remove(oid, sender, ev);

    // for testing only
    this._matcher.events.emit('process');
}

OrderProcessor.prototype._sub = function(dict, ev) {
    var key;
    if(dict)
        key = dict.key;
    ev.pubsub.sub(key);
}

OrderProcessor.prototype._unsub = function(dict, ev) {
    var key;
    if(dict)
        key = dict.key;
    ev.pubsub.unsub(key);
}

exports.ReqProcessor = OrderProcessor;
