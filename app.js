var express = require('express')
var app     = express();
var server  = require('http').Server(app);
var io      = require('socket.io')(server);
var sockets = [];
var request = require('request');

var endpoint    = 'https://micropurchase.18f.gov/auctions/';
var refresh     = 10;
var notToExceed = 500;

var auctionID = 24; // Set this;
var userID    = 173; // Set this;
var authToken = '542364db3aac38f89c68f6034861e0d62d6c3910';

app.use(express.static('public'));

server.listen(1337);

io.on('connection', function(socket) {
  console.log('Client has connected.');
  socket.on('disconnect', function(){
    var index = sockets.indexOf(socket);
    sockets.splice(index, 1);
    console.log('Client has disconnected. Still have ', sockets.length);
  });
  sockets.push(socket);
});

function getAuction(callback) {
  var options = {
    url: endpoint + auctionID,
    headers: {
      'Accept': 'text/x-json'
    }
  };

  request(options, function(error, response, body) {
    if (error) return callback(error);
    callback(null, JSON.parse(body));
  });
}

function bidAuction(bid, callback) {
  if (bid >= notToExceed) {
    console.log('Bidding $', bid, '...');

    var options = {
      url: endpoint + auctionID + '/bids',
      headers: {
        'Accept':       'text/x-json',
        'Content-Type': 'application/json',
        'Api-Key':      authToken,
      },
      body: '{"bid": {"amount": ' + bid + '}}'
    };

    request.post(options, function(error, response, body) {
      if (error) console.log(error);
      callback(null, JSON.parse(body));
    });
  }
  else {
    var msg = 'Bid is below the minimum of $' + notToExceed + '.';
    console.log(msg);
    callback(true, { error: msg });
  }
}

function eachSocket(handle, payload) {
  for(i = 0; i < sockets.length; i++) {
    sockets[i].emit(handle, payload);
  }
}

var counter = refresh;
setInterval( function() {
  eachSocket('tick', counter--);

  if (counter === 0) {
    counter = refresh;

    getAuction( function(err, res){
      if (err) { eachSocket('error', { payload: err }); }
      else {

        // If user is the current winning bid.
        if (res.auction.winning_bid.bidder_id === userID) {
          eachSocket('status', {
            payload: {
              auction: res.auction,
              winning: true
            }
          });
        }

        // If user is no longer the current winning bid
        else {
          eachSocket('status', {
            payload: {
              auction: res.auction,
              winning: false
            }
          });

          // Bid on the auction for one dollar less than the winning amount
          var bid = res.auction.winning_bid.amount - 1;
          bidAuction(bid, function(err, res) {
            if (err) { eachSocket('error', { payload: err }); }
            else {
              console.log('Winning with ', bid);
              eachSocket('status', {
                payload: {
                  auction: res.auction,
                  winning: true
                }
              });
            }
          });
        }
      }
    });
  }
}, 1000);
