
// TODO: standardize the names used here
function Order(id, price, size, side, sender) {
    this.id = id;
    this.price = price;
    this.size = size;
    this.side = side;
    this.sender = sender;
}

Order.parse = function(order_dict) {
    return new Order(order_dict.order_id,
                     order_dict.price,
                     order_dict.size,
                     order_dict.side,
                     order_dict.sender_id);
}

Order.prototype.toString = function() {
    return "" + this.size + "@" + this.price;
}

Order.prototype.state = function() {
    return {
        "price": this.price,
        "size": this.size,
        "id": this.id,
        "sender_id": this.sender
    };
}
module.exports = Order;
