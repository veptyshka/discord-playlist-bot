"use strict";

//TODO: cleanup debug statements

const auth = require("./auth.json"); //load tokens using require since they shouldn't be modified
const https = require("https");
const ws = require("ws");
const qs = require("querystring");

// Updated URL for Discord API
const DISCORD_API_BASE = "https://discord.com/api/v10";
const GATEWAY_URL = DISCORD_API_BASE + "/gateway";

https.get(GATEWAY_URL, function(res){ //get the WebSocket gateway from Discord
    var data = "";
    res.on('data',function(res){data += res;});
    res.on('end',function(){runBot(JSON.parse(data).url);});
});

function getDate(){
    var date = new Date();
    return date.toISOString();
}

function runBot(gateway){
    // Added API version and encoding for gateway URL
    var gatewayUrl = gateway + "/?v=10&encoding=json";
    var connection = new ws(gatewayUrl);
    var sendHeartbeat = false;
    var heartbeatSender = null; //holds the setInterval object that sends websocket heartbeat
    var lastSequenceNum = null;
    var uploadPlaylistID = null;
    var discordChannel = null;
    var playlistID = null;
    var lastCheck = getDate();
    var scheduler = null; //holds the setInterval object that calls getUploads every X mins
    var rateLimitReset = 5000; //delay sending messages for this amount of time (in ms) to reset the rate limit
    var rateLimit = 1; //default rateLimit set to 1
    var rateSent = 0; //number of message requests sent
    var rateLimitTimer = null;
    var sessionId = null; // For reconnect
    var resumeGatewayUrl = null;

    function handleMessage(message) {
        if (message.op == 11) { // HEARTBEAT_ACK
            sendHeartbeat = false;
        } else if (message.s) {
            lastSequenceNum = message.s;
        }
        
        if (message.op == 0){ // DISPATCH
            if (message.t == "READY") {
                sessionId = message.d.session_id;
                resumeGatewayUrl = message.d.resume_gateway_url;
            } else if (message.t == "MESSAGE_CREATE"){
                let reResult = null;
                if (reResult = message.d.content.match(/^yp!set\s([^\s]+)/)){ //set playlistID
                    sendMessage("Playlist set to " + reResult[1]);
                    playlistID = reResult[1];
                    getChannel();
                    if (!scheduler){
                        scheduler = setInterval(getUploads, 1800000); //schedule checking for uploads every 30 mins
                    }
                } else if (message.d.content.match(/^yp!get/)) {
                    getUploads();
                } else if (message.d.content.match(/^yp!channel/)) {
                    discordChannel = message.d.channel_id;
                    sendMessage("Output channel set");
                } else if (message.d.content.match(/^yp!help/)) {
                    sendMessage("**YouTube Playlist Bot Commands:**\n" +
                               "`yp!set [playlistId]` - Set playlist to monitor\n" +
                               "`yp!get` - Manually check for new videos\n" +
                               "`yp!channel` - Set this channel for notifications\n" +
                               "`yp!help` - Show this help message");
                }
            } else if (message.t == "GUILD_CREATE") {
                for (let ch of message.d.channels){
                    if (ch.type == 0){ //default channel will be the first text channel
                        discordChannel = ch.id;
                        break;
                    }
                }
            }
        } else if (message.op == 10){ // HELLO
            heartbeatSender = setInterval(function(){
                if (sendHeartbeat == true){ //connection is broken
                    clearInterval(heartbeatSender);
                    reconnect();
                    return;
                }
                connection.send(JSON.stringify({
                    "op" : 1,
                    "d" : lastSequenceNum
                }));
                sendHeartbeat = true;
            }, message.d.heartbeat_interval);
        } else if (message.op == 7) { // RECONNECT
            reconnect();
        } else if (message.op == 9) { // INVALID_SESSION
            console.log("Invalid session, starting new session");
            setTimeout(() => {
                identify();
            }, Math.random() * 5000 + 1000);
        }
        console.log(message);
    }

    function identify() {
        connection.send(JSON.stringify({
            "op": 2,
            "d": {
                "token": auth.discord_token,
                "intents": 512, // GUILD_MESSAGES intent
                "properties": {
                    "$os": "linux",
                    "$browser": "nodejs",
                    "$device": "nodejs"
                }
            }
        }));
    }

    function reconnect() {
        if (heartbeatSender) {
            clearInterval(heartbeatSender);
        }
        connection.close();
        
        setTimeout(() => {
            if (resumeGatewayUrl && sessionId) {
                // Try to resume
                connection = new ws(resumeGatewayUrl + "/?v=10&encoding=json");
                setupConnectionHandlers();
                connection.on('open', function(){
                    connection.send(JSON.stringify({
                        "op": 6, // RESUME
                        "d": {
                            "token": auth.discord_token,
                            "session_id": sessionId,
                            "seq": lastSequenceNum
                        }
                    }));
                });
            } else {
                // Start fresh connection
                runBot(gateway);
            }
        }, 5000);
    }

    function setupConnectionHandlers() {
        connection.on('message', function(res){
            try {
                const message = JSON.parse(res);
                handleMessage(message);
            } catch (e) {
                console.error("Failed to parse message:", e);
            }
        });

        connection.on('error', function(error) {
            console.error("WebSocket error:", error);
        });

        connection.on('close', function(code, reason) {
            console.log("Connection closed:", code, reason);
            if (code !== 1000) { // Not normal closure
                reconnect();
            }
        });
    }

    function sendMessage(message){
        if (rateSent >= rateLimit) {
            setTimeout(sendMessage, rateLimitReset, message); //do nothing, try again after the rateLimitReset
        } else if (discordChannel){
            rateSent += 1; //update because we sent a message request
            let request = https.request({
                hostname: 'discord.com', // Updated hostname
                path: '/api/v10/channels/'+ discordChannel +'/messages', // Added API version
                method: 'POST',
                agent: new https.Agent(this),
                headers: {
                    "Authorization": "Bot " + auth.discord_token,
                    "User-Agent": "discord-playlist-bot (https://github.com/Soldann/discord-playlist-bot, v2.0.0)",
                    "Content-Type": "application/json",
                }
            }, function(res){
                if (res.statusCode == 429){
                    console.error("Rate Limited!");
                }
                //update rateLimit variables in case they have changed
                if (res.headers["x-ratelimit-limit"]) {
                    rateLimit = res.headers["x-ratelimit-limit"];
                }
                if (res.headers["x-ratelimit-reset-after"]) {
                    rateLimitReset = res.headers["x-ratelimit-reset-after"] * 1000; //change from seconds to ms
                }

                //don't allow multiple instances, use the most recent data
                clearTimeout(rateLimitTimer); 
                rateLimitTimer = setTimeout(() => {rateSent = 0;}, rateLimitReset);
            });
            
            request.on('error', function(err) {
                console.error('Request error:', err);
                rateSent -= 1; // Reduce counter on error
            });
            
            request.write(JSON.stringify({
                content: message,
                tts: false
            }), function(err){ 
                if (err) console.error('Write error:', err);
                request.end(); 
            });
        } else {
            console.error("no discord channels detected");
        }
    }

    function getChannel(){
        if (playlistID == null){
            console.error("no playlist id");
        } else {
            https.get("https://www.googleapis.com/youtube/v3/playlists?" + qs.stringify({
                part: "snippet",
                id: playlistID,
                maxResults: 1,
                key: auth.youtube_token
            }), function(res){
                var data = "";
                res.on('data', function(d){
                    data += d;
                });
                res.on('end', function(){
                    try {
                        data = JSON.parse(data);
                        if (data.error) {
                            console.error("YouTube API Error:", data.error);
                            sendMessage("Error: " + data.error.message);
                        } else if (data.items && data.items.length > 0){
                            getUploadPlaylistID(data.items[0].snippet.channelId);
                        } else {
                            console.error("playlist not found");
                            sendMessage("Playlist not found or is private");
                            playlistID = null;
                        }
                    } catch (e) {
                        console.error("Failed to parse YouTube response:", e);
                    }
                });
            }).on('error', function(err) {
                console.error("YouTube API request error:", err);
            });
        }  
    }

    function getUploadPlaylistID(channelID){
        https.get("https://www.googleapis.com/youtube/v3/channels?" + qs.stringify({
            part: "contentDetails",
            id: channelID,
            maxResults: 1,
            key: auth.youtube_token
        }), function(res){
            var data = "";
            res.on('data', function(d){
                data += d;
            });
            res.on('end', function(){
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) {
                        console.error("YouTube API Error:", parsed.error);
                    } else if (parsed.items && parsed.items.length > 0) {
                        uploadPlaylistID = parsed.items[0].contentDetails.relatedPlaylists.uploads;
                    }
                } catch (e) {
                    console.error("Failed to parse channel response:", e);
                }
            });
        }).on('error', function(err) {
            console.error("Channel API request error:", err);
        });
    }

    function getUploads(){
        function requestPlaylistItems(pageToken=""){
            https.get("https://www.googleapis.com/youtube/v3/playlistItems?" + qs.stringify({
                part: "snippet",
                playlistId: uploadPlaylistID,
                maxResults: 25,
                pageToken: pageToken, // Changed from nextPageToken
                key: auth.youtube_token
            }), function(res){
                var data = "";
                res.on('data', function(d){
                    data += d;
                })
                res.on('end', function(){
                    try {
                        data = JSON.parse(data);
                        if (data.error) {
                            console.error("YouTube API Error:", data.error.code + ": " + data.error.message);
                        } else {
                            if (data.nextPageToken && data.items && data.items.length > 0 && 
                                data.items[data.items.length - 1].snippet.publishedAt >= lastCheck){ 
                                console.log("next page");
                                requestPlaylistItems(data.nextPageToken); //recursively iterate through pages
                            }
                            
                            if (data.items) {
                                for (let videos of data.items){
                                    if (videos.snippet.publishedAt < lastCheck) {
                                        break;
                                    }
                                    vidCheck(videos.snippet.resourceId.videoId);
                                }
                            }
                            lastCheck = getDate();
                        }
                    } catch (e) {
                        console.error("Failed to parse playlist response:", e);
                    }
                })
            }).on('error', function(err) {
                console.error("Playlist API request error:", err);
            });
        }
        
        if (uploadPlaylistID === null){
            console.error("no channel defined")
        } else {
            requestPlaylistItems();
        }
    }

    function vidCheck(vidID){
        if (playlistID === null){
            console.error("no playlist defined")
        } else {
            https.get("https://www.googleapis.com/youtube/v3/playlistItems?" + qs.stringify({
                part: "snippet",
                playlistId: playlistID,
                maxResults: 50, // Increased for better search
                videoId: vidID,
                key: auth.youtube_token
            }), function(res){
                var data = "";
                res.on('data', function(d){
                    data += d;
                })
                res.on('end', function(){
                    try {
                        data = JSON.parse(data);
                        if (data.error) {
                            console.error("Video check error:", data.error);
                        } else if (data.items && data.items.length > 0){
                            console.log("Video found in playlist:", data.items[0]);
                            const video = data.items[0];
                            const videoUrl = "https://youtu.be/" + video.snippet.resourceId.videoId;
                            const channelName = video.snippet.videoOwnerChannelTitle || "Unknown Channel";
                            
                            sendMessage("🎥 **New video added to playlist!**\n" +
                                      "**" + video.snippet.title + "**\n" +
                                      "Channel: " + channelName + "\n" +
                                      videoUrl);
                        }
                        //video not in playlist - no action needed
                    } catch (e) {
                        console.error("Failed to parse video check response:", e);
                    }
                })
            }).on('error', function(err) {
                console.error("Video check request error:", err);
            });
        }
    }

    connection.on('open', function(){
        identify();
    });

    setupConnectionHandlers();
}