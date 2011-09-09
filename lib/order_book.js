// builtin
var events = require('events');

var Tree = require('bintrees').RBTree;

// keeps a list of orders at a given price level
function BookLevel(price) {
    this.price = price;
    this.orders = [];
}

// add an order to the level
BookLevel.prototype.add = function(order) {
    this.orders.push(order);
};

// remove an order from the level
BookLevel.prototype.remove = function(order) {
    var orders = this.orders
    var index = orders.indexOf(order);
    orders.splice(index, 1);
};

function OrderBook() {
    this._bid = new Tree(function(a, b) { return a.price - b.price; });
    this._ask = new Tree(function(a, b) { return a.price - b.price; });
    this._by_oid = {};
}

// the order book emits level_update events
// level_update(side, price, size)
OrderBook.prototype = new events.EventEmitter();

/// return the order tree for the given book side
/// bid: 0, ask: 1
OrderBook.prototype._get_tree = function(side) {
    return side == 0 ? this._bid : this._ask;
}

/// insert an order into the order book
OrderBook.prototype._insert = function(order) {
    var price = order.price;

    var tree = this._get_tree(order.side);

    var level = tree.find(order);

    // no existing level, make new
    if(!level) {
        level = new BookLevel(price);
        tree.insert(level);
    }

    // add order to level and order id map
    level.add(order);
    this._by_oid[order.id] = order;

    this.emit('add_order', order);

    // TODO handle case where order could not be added for some reason
}

/// delete an order from the order book
OrderBook.prototype._delete = function(order) {
    delete this._by_oid[order.id];

    // get the side of the book for the order we want removed
    var tree = this._get_tree(order.side);

    // get the price level orders
    var level = tree.find(order);
    var orders = level.orders;

    if(level.orders.length == 1) {
        // we are the only order in the array
        // can remove the whole level
        tree.remove(level);
    } else {
        level.remove(order);
    }

    this.emit('order_done', order);
}

/*
 * removes order by oid if it exists and it has the correct user_id
 */
OrderBook.prototype.remove = function(oid, user_id) {
    var order = this._by_oid[oid];
    if(!order)
        return new Error('not found');

    if(order.user_id != user_id)
        return new Error('invalid user_id');

    // ok to remove the order
    this._delete(order);
}

/// attempt to add the order to the order book
/// will match the order first before trying to add it
OrderBook.prototype.add = function(order) {
    while(this._match_one(order)) {}

    if (order.size < 0) {
        logger.panic('order size < 0 after matching (oid): ' + order.id, order);
        return;
    } else if(order.size == 0) {
        // order was fully consumed
        this.emit('order_done', order);
        return;
    }

    // if the order was not fully matched, then it will be put into the order book
    this._insert(order);
}

/// match the order against an existing orders in the order book
/// only match against the first available order
/// returns false if there can't be any more matches
/// either due to price being too low or no remaining orders
OrderBook.prototype._match_one = function(order) {

    // the complementary order for the one we want to match
    var best;

    if(order.side == 0) {
        // order is bid, need the best ask
        var level = this._ask.min();
        if(!level)
            return false;

        best = level.orders[0];

        // for a bid, the best price should be <= the order price
        // if the best price > order price, then we can't match
        if(best.price > order.price)
            return false;
    } else if(order.side == 1) {
        // order is ask, need the best bid
        var level = this._bid.max();
        if(!level)
            return false;

        best = level.orders[0];

        // for an ask, the best price should be >= order price
        // if the best price < order price, then we can't match
        if(best.price < order.price)
            return false;
    } else {
        assert(false);
    }

    if (!best)
        return false;

    // size is the smaller of the two complimentary orders
    var size = Math.min(order.size, best.size);
    order.size -= size;
    best.size -= size;

    // mark the orders as done if they are fully exhaused
    // match will use this information
    if (best.size == 0)
        best.done = true;

    if (order.size == 0)
        order.done = true;

    // the match happens at best.price
    // send out a single match event for the whole match
    // this will send out a done event for each order if it was completed
    // the best order has already been removed at this point if it was done

    this.emit('match', size, order, best);

    // if best was fully consumed, then it can be removed from the book
    // this should happen after the match because it will cause a done message to occur
    // only best needs to be deleted because order was not added yet
    if (best.done)
        this._delete(best);

    // will cause the order to be added to the order book
    return order.size > 0;
}

OrderBook.prototype.state = function() {
    var bids = [];
    var asks = [];

    this._bid.reach(function(e) {
        e.orders.forEach(function(o) {
            bids.push(o.state());
        });
    });

    this._ask.each(function(e) {
        e.orders.forEach(function(o) {
            asks.push(o.state());
        });
    });

    return {
        bids: bids,
        asks: asks
    };
}

exports.OrderBook = OrderBook;
