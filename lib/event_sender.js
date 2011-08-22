
// builtin
var events = require('events');

// common
var logger = require('../../common/logger');
var Journal = require('../../common/journal');

/// event sender emits events for client connections
/// these messages go back to clients on their bi-directional tcp channel
function EventSender() {
};

// emits event(sender, msg)
EventSender.prototype = new events.EventEmitter();

// indicate that the exchange has received the order and will execute against it
EventSender.prototype.open = function(order) {
    this._send_type('order_status', order.sender, {
        status: 'open',
        side: order.side,
        order_id: order.id,
        price: order.price,
        size: order.size,
        exchange_time: Date.now()
    });
}

// indicate that the order was cancelled
EventSender.prototype.cancelled = function(order) {
    this._send_type('order_status', order.sender, {
        status: 'done',
        reason: 'cancelled',
        order_id: order.id,
        exchange_time: Date.now()
    });
}

// indicate that the cancel request was rejected
EventSender.prototype.cancel_reject = function(oid, sender, message) {
    // don't need to journal failed cancels because they do not affect the state of the matcher
    this._send_type('cancel_reject', sender, {
        order_id: oid,
        reject_reason: message
    });
};

// send a fill for the given order
EventSender.prototype.fill = function(time, size, order, liquidity) {
    var self = this;

    self._send_type('fill', order.sender, {
        order_id: order.id,
        size: size,
        liquidity: liquidity,
        price: order.price,
        exchange_time: time
    });
};

// indicate the order has been completed
EventSender.prototype.done = function(order) {
    var self = this;
    self._send_type('order_status', order.sender, {
        status: 'done',
        reason: 'filled',
        order_id: order.id,
        exchange_time: Date.now()
    });
};

EventSender.prototype._send_type = function(type, sender, payload) {
    var self = this;
    self.emit('event', sender, {
        type: type,
        timestamp: Date.now(),
        target_id: sender,
        payload: payload
    });
}

exports.EventSender = EventSender;
