var util = require('./util');

var logger = require('../../common/logger');
var Journal = require('../../common/journal');

/// journals events and sends notifications via pubsub
function EventSender(pubsub) {
    this.journal = new Journal('matcher', false);
    this.pubsub = pubsub;
}

EventSender.prototype.add = function(order) {
    this._send_type('order_status', order.sender, true, {
        status: 'open',
        order_id: order.id,
        exchange_time: Date.now()
    });
}

EventSender.prototype.cancelled = function(order) {
    this._send_type('order_status', order.sender, true, {
        status: 'done',
        reason: 'cancelled',
        order_id: order.id,
        exchange_time: Date.now()
    });
}

EventSender.prototype.cancel_failed_not_found = function(oid, sender) {
    // don't need to journal failed cancels because they do not affect the state of the matcher
    this._send_type('cancel_reject', sender, false, {
        order_id: oid,
        reject_reason: 'not found'
    });
}

EventSender.prototype.cancel_failed_sender = function(oid, sender) {
    // don't need to journal failed cancels because they do not affect the state of the matcher
    this._send_type('cancel_reject', sender, false, {
        order_id: oid,
        reject_reason: 'invalid sender'
    });
}

/// writes out a match event to the journal,
/// and sends out 2 fill/done status updates over pubsub
EventSender.prototype.match = function(size, taker, provider) {
    var time = Date.now();
    var self = this;
    var size_float = util.size2float(size);
    var price_float = provider.price_float();

    function fill(order) {
        self._send_type('fill', order.sender, false, {
            order_id: order.id,
            size: size_float,
            liquidity: order == provider,
            price: price_float,
            exchange_time: time
        });

        if(order.size == 0) {
            // don't need to journal done-filled status because state can be reconstructed from the rest of the journal
            self._send_type('order_status', order.sender, false, {
                status: 'done',
                reason: 'filled',
                order_id: order.id,
                exchange_time: time
            });
        }
    }

    // only send out fill messages after the journal has been logged to
    this.journal.log({
        type: 'match',
        timestamp: time,
        payload: {
            taker_id: taker.id,
            provider_id: provider.id,
            size: size_float,
            price: price_float
        }
    }, function() {
        fill(taker);
        fill(provider);
    });
}

EventSender.prototype._send_type = function(type, sender, journal, dict) {
    this._send(sender, journal, {
        type: type,
        timestamp: Date.now(),
        target_id: sender,
        payload: dict
    });
}

EventSender.prototype._send = function(sender, journal, dict) {
    var self = this;

    if(journal) {
        logger.trace('journaling and sending message to ' + sender + ', msg: ' + dict.type);
        // only send out pubsub message after journal has been logged to
        this.journal.log(dict, function() {
            self.pubsub.pub(dict, sender);
        });
    }
    else {
        logger.trace('sending message to ' + sender + ', msg: ' + dict.type);
        self.pubsub.pub(dict, sender);
    }
}

exports.EventSender = EventSender;
