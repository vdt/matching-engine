var Tree = require('bintrees').RBTree;

function OrderBook() {
    this._bid = new Tree(function(a, b) { return a.price - b.price; });
    this._ask = new Tree(function(a, b) { return a.price - b.price; });
    this._by_oid = {};
}

// bid: 0, ask: 1
OrderBook.prototype._get_tree = function(side) {
    return side == 0 ? this._bid : this._ask;
}

OrderBook.prototype._insert = function(order) {
    var price = order.price;

    var tree = this._get_tree(order.side);

    var list = tree.find(new Price(price));

    if(!list) {
        list = new OrderList(price);
        tree.insert(list);
    }

    list.arr.push(order);
    this._by_oid[order.id] = order;
}

OrderBook.prototype._delete = function(order) {
    delete this._by_oid[order.id];

    var po = new Price(order.price);

    var tree = this._get_tree(order.side);

    var arr = tree.find(po).arr;

    if(arr.length == 1) {
        // we are the only order in the array
        tree.remove(po);
    }
    else {
        var index = arr.indexOf(order);
        arr.splice(index, 1);
    }
}

/*
 * removes order by oid if it exists and it has the correct sender
 */
OrderBook.prototype.remove = function(oid, sender, ev) {
    var order = this._by_oid[oid];
    if(!order) {
        ev.cancel_failed_not_found(oid, sender);
        return;
    }

    if(order.sender != sender) {
        ev.cancel_failed_sender(oid, sender);
        return;
    }

    this._delete(order);

    ev.cancelled(order);
}

OrderBook.prototype.add = function(order, ev) {
    while(this._match_one(order, ev)) {}

    if(order.size > 0)
        this._insert(order);
}

/* returns false if there can't be any more matches
 * (either due to price being too low or no remaining order)
 */
OrderBook.prototype._match_one = function(order, ev) {
    var best;
    
    if(order.side == 0) {
        // bid
        best = this._ask.min();
        if(!best)
            return false;
        best = best.arr[0];

        if(best.price > order.price)
            return false;
    }
    else if(order.side == 1) {
        // ask
        best = this._bid.max();
        if(!best)
            return false;
        best = best.arr[0];

        if(best.price < order.price)
            return false;
    }
    else
        assert(false);

    // match
    var size = Math.min(order.size, best.size);
    order.size -= size;
    best.size -= size;

    ev.match(size, order, best);

    if(best.size == 0)
        this._delete(best);

    return order.size > 0;
}

OrderBook.prototype.state = function() {
    var bids = [];
    var asks = [];

    this._bid.reach(function(e) {
        e.arr.forEach(function(o) {
            bids.push(o.state());
        });
    });

    this._ask.each(function(e) {
        e.arr.forEach(function(o) {
            asks.push(o.state());
        });
    });

    return {
        bids: bids,
        asks: asks
    };
}


function OrderList(price) {
    this.price = price;
    this.arr = [];
}

function Price(price) {
    this.price = price;
}

exports.OrderBook = OrderBook;
