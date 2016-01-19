/*
Routes for API. The parameters are: 
POST (your location)
    id (optional)
    latitude
    longitude
    timestamp
GET (location of friend)
    id
*/

module.exports = function(app, passport) {
    //TODO: Enhance security with app-secret proof
    //TODO: Rewrite routes to scale (can't do more than ~600 graph requests per second)

    // MARK: Facebook routes
    app.get('/auth/facebook', passport.authenticate('facebook', 
        // Scope determines permissions associated with token
        { scope: ['email', 'user_friends'],
          session : false
         }
        )
    );

    //Success/fail options upon Facebook auth
    app.get('/auth/facebook/callback',
        passport.authenticate('facebook', {
            successRedirect : '/testSuccess',
            failureRedirect : '/'
        }));

    app.get("/testSuccess", function(request, response) {
        response.send("Great success logging in");
    });

    //home page
    app.get( '/', function(request, response) {
        response.render("index.ejs", function(err, html) {
            response.send(html);
        });
    });

    //MARK: RESTful API routes
    //Route different requests to different dbms actions
    //GET runner data (spectator)
    // TODO: Validate URL params on requests prior to anything else
    app.get( '/api/runner/', function(request, response) {
        var accessToken = request.get("access-token");
        var get = function(id) {
            var msg = getFromDatabase(id, function(msg) {
                response.send(msg);
            });
        };

        getIdFromToken(accessToken, function(cachedID) {
            // var id = request.params.id;
            var id = request.query.id;
            canFollow(cachedID, id, function(can) {
                if (can) {
                    get(id);
                } else {
                    //TODO: What is the overhead of reloading graph for each request?
                    // ^ If this becomes a problem, look into FB's Javascript API
                    var graph = require('fbgraph');
                    if (accessToken) graph.setAccessToken(accessToken);

                    graph.get("me/friends/" + id, function(err, graphRes) {
                        //Check if user is friends with id by seeing if query is non-empty
                        //TODO: Find a more robust way to do this
                        if (err) {
                            response.send("ERROR::FBAUTH error on get (expired token?)");
                        } else if (graphRes && graphRes.data && graphRes.data[0]) { 
                            // graphRes not null -> response from Facebook
                            // graphRes.data not null -> response is nonempty (access token valid)
                            // graphRes.data[0] not null -> users are friends
                            updateCanFollow(cachedID, graphRes.data[0].id);
                            get(graphRes.data[0].id);
                        } else {
                            //they must not be friends
                            response.send("ERROR::Get non-friend or nonexistent user");
                        }
                    });
                }
            });

        });
    });

    // POST runner data (runner)
    // TODO: Fix graph response bug in post (in event that server can't connect to FB)
    app.post( '/api/runner/', function(request, response) {
        var post = function() {
            postToDatabase(request.query.id,
                request.query.latitude,
                request.query.longitude,
                request.query.timestamp, function(msg) {
                    response.send(msg);
                });  
        } 

        var accessToken = request.get("access-token");
        getIdFromToken(accessToken, function(cachedID) {
            if (cachedID === request.query.id) {
                console.log("Using cached token");
                post();
            } else {
                var graph = require('fbgraph');
                graph.setAccessToken(accessToken);
                graph.get("me?fields=id,name,friends", function(err, res) {
                    console.log(res);
                    var tokenId = res.id;
                    console.log(tokenId);
                    if (!err) {
                        if (request.query.id === tokenId) {
                            updateTokenCache(request.query.id, accessToken);
                            post();                            
                        } else {
                            response.send("ERROR::ID associated with token != sent ID");
                        }

                    } else {
                        console.log("ERROR::FBAUTH error when posting");
                        response.send("ERROR::FBAUTH error when posting");
                    }
                }); 
            }
        });       
    });

}


var squel = require("squel").useFlavour('mysql');
var pool = require("../config/connection.js");

//MARK: Caching functions

var canFollow = function(followerID, followedID, next) {
    var query = squel
        .select().from("CanFollow").where("FollowerID = " + followerID)
        .where("FollowedID = " + followedID)
        .toString() + ";";
    console.log(query);
    execQuery(query, function(err, rows, fields) {
        next(rows.length == 1);
    }); 
}

var updateCanFollow = function(followerID, followedID) {
    var query = squel
        .insert()
        .into("CanFollow")
        .set("FollowerID", followerID)
        .set("FollowedID", followedID)
        .toString() + ";";
    execQuery(query, function(err, rows, fields) {
        console.log("Update CanFollow: " + followerID + " - " + followedID);
    });    
}

//TODO: Fix spaghetti code around getting IDs from token
var getIdFromToken = function(sentToken, next) {
    var query = squel
        .select().from("TokenCache").where("Token = '" + sentToken + "'").toString() + ";";
    console.log(query);
    execQuery(query, function(err, rows, fields) {
        if (err) {
            console.log("ERROR::SQL Output " + err);
            next("ERROR::Retrieving cached ID"); //TODO: Handle error
        } 
        // else if (rows.length > 1) { //Corner-case
        //     console.log("TODO: Drop data where same token maps to different IDs");
        // }
        else if (rows.length == 0) {
            var graph = require('fbgraph');
            graph.setAccessToken(sentToken);
            graph.get("me?fields=id,name,friends", function(err, res) {
                var tokenId = res.id;
                if (!err) {
                    updateTokenCache(tokenId, sentToken);
                    next(tokenId);              
                }
            });             
        } else {
            cachedToken = rows[0];
            console.log("Retrieve cached token: ", cachedToken);
            next(cachedToken.RunnerID);
        }
    });    
}

var updateTokenCache = function(id, token) {
    var query = squel
        .insert()
        .into("TokenCache")
        .set("RunnerID", id)
        .set("Token", token)
        .onDupUpdate("Token", token)
        .toString() + ";";
    execQuery(query, function(err, rows, fields) {
        console.log("Update token cache: " + id + " - " + token);
    });
};

//MARK: Format RESTful params into SQL queries and send back response
var getFromDatabase = function(id, out) {
    // var tokenId = data[0].id;
    // console.log("Get: ", data); //data contains name, id
    //TODO: Assert id == tokenId 
    // ^(may not be necessary as GET has already validated requester is friends with id)
    var query = squel
        .select()
        .from("Runner")
        .where("RunnerID = " + id)
        .toString() + ";";
    console.log(query);

    execQuery(query, function(err, rows, fields) {
        if (err) {
            //TODO: More consistent error messages
            out("ERROR::SQL Output " + err);
            // throw err; //throwing shuts down server
        } else {
            if (rows[0]) { //i.e., if the response is not null/undefined
                console.log('Retrieved ', rows[0]);     
                out(rows[0]);
            } else {
                out("ERROR::DBMS attempt to access user with no defined location");
            }
        }
    });
}

var postToDatabase = function(id, latitude, longitude, timestamp, out) {
    var query = squel
        .insert()
        .into("Runner")
        .set("RunnerID", id)
        .set("Latitude", latitude)
        .set("Longitude", longitude)
        .set("TimeStamp", timestamp)
        .onDupUpdate("Latitude", latitude)
        .onDupUpdate("Longitude", longitude)
        .onDupUpdate("TimeStamp", timestamp)
        .toString() + ";";

    console.log(query);
    // var pool = require("../config/connection.js");
    execQuery(query, function(err, rows, fields) {
        if (err) {
            out("ERROR::DBMS error when posting::" + err);
        } else {
            out("POST_SUCCESS");
        }
    });
}

// Get a connection from the pool, and call callback upon query
var execQuery = function(query, callback) {
    pool.getConnection(function(err, connection) {
        if (err) {
            //TODO: Better error handling here
            console.log("Error in connection pool");
        } else {
            connection.query(query, function(err, rows, fields) {
                callback(err, rows, fields);
            });
            connection.release();            
        }
    });    
}
