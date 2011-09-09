
// TODO: standardize the names used here
function Order(id, price, size, side, user_id) {
    this.id = id;
    this.price = price;
    this.size = size;
    this.side = side;
    this.user_id = user_id;
}

Order.parse = function(order_dict) {
    return new Order(order_dict.order_id,
                     order_dict.price,
                     order_dict.size,
                     order_dict.side,
                     order_dict.user_id);
}

Order.prototype.toString = function() {
    return "" + this.size + "@" + this.price;
}

Order.prototype.state = function() {
    return {
        "price": this.price,
        "size": this.size,
        "order_id": this.id,
        "user_id": this.user_id
    };
}
module.exports = Order;
