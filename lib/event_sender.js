var msgpack = require('msgpack-0.4');

var util = require('./util');

function EventSender(pubsub) {
    this.pubsub = pubsub;
}

EventSender.prototype.add = function(order) {
    this._send_type('order_status', order.sender, {
        status: 'open',
        order_id: order.id,
        exchange_time: Date.now()
    });
}

EventSender.prototype.cancelled = function(order) {
    this._send_type('order_status', order.sender, {
        status: 'done',
        reason: 'cancelled',
        order_id: order.id,
        exchange_time: Date.now()
    });
}

EventSender.prototype.cancel_failed_not_found = function(oid, sender) {
    this._send_type('cancel_reject', sender, {
        order_id: oid,
        reject_reason: 'not found'
    });
}

EventSender.prototype.cancel_failed_sender = function(oid, sender) {
    this._send_type('cancel_reject', sender, {
        order_id: oid,
        reject_reason: 'invalid sender'
    });
}

EventSender.prototype.match = function(size, taker, provider) {
    var time = Date.now();
    var self = this;

    function fill(order) {
        self._send_type('fill', order.sender, {
            order_id: order.id,
            size: util.size2float(size),
            liquidity: order == provider,
            price: provider.price_float(),
            exchange_time: time
        });

        if(order.size == 0) {
            self._send_type('order_status', order.sender, {
                status: 'done',
                reason: 'filled',
                order_id: order.id,
                exchange_time: Date.now()
            });
        }
    }

    fill(taker);
    fill(provider);
}

EventSender.prototype._send_type = function(type, sender, dict) {
    this._send(sender, {
        type: type,
        timestamp: Date.now(),
        target_id: sender,
        payload: dict
    });
}

EventSender.prototype._send = function(sender, dict) {
    var msg = msgpack.pack(dict);
    this.pubsub.pub(msg, sender);
}

exports.EventSender = EventSender;
