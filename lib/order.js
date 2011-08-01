var util = require('./util');

function Order(id, price, size, side, sender) {
    this.id = id;
    this.price = price;
    this.size = size;
    this.side = side;
    this.sender = sender;
}

Order.parse = function(order_dict) {
    return new Order(order_dict.order_id,
                     Math.round(order_dict.price*1e2),
                     Math.round(order_dict.size*1e8),
                     order_dict.side,
                     order_dict.sender_id);
}

Order.prototype.toString = function() {
    return "" + this.size + "@" + this.price;
}

Order.prototype.price_float = function() {
    return this.price/1.0e2;
}

Order.prototype.size_float = function() {
    return util.size2float(this.size);
}

Order.prototype.state = function() {
    return {
        "price": this.price_float(),
        "size": this.size_float(),
        "id": this.id,
        "sender_id": this.sender
    };
}
module.exports = Order;
