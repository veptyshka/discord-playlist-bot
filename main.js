const { Client, GatewayIntentBits } = require('discord.js');
const https = require('https');
const qs = require('querystring');
const auth = require('./auth.json');


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let playlistID = null;
let uploadPlaylistID = null;
let discordChannel = null;
let lastCheck = new Date().toISOString();
let scheduler = null;


function makeYouTubeRequest(url, callback) {
    https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
            data += chunk;
        });
        res.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                callback(null, parsed);
            } catch (error) {
                callback(error, null);
            }
        });
    }).on('error', (error) => {
        callback(error, null);
    });
}

function getPlaylistInfo(playlistId, callback) {
    const url = `https://www.googleapis.com/youtube/v3/playlists?${qs.stringify({
        part: 'snippet',
        id: playlistId,
        maxResults: 1,
        key: auth.youtube_token
    })}`;
    
    makeYouTubeRequest(url, (error, data) => {
        if (error) {
            callback(error, null);
            return;
        }
        
        if (data.error) {
            callback(new Error(data.error.message), null);
            return;
        }
        
        if (!data.items || data.items.length === 0) {
            callback(new Error('Playlist is private or not found'), null);
            return;
        }
        
        callback(null, data.items[0]);
    });
}

function getUploadPlaylist(channelId, callback) {
    const url = `https://www.googleapis.com/youtube/v3/channels?${qs.stringify({
        part: 'contentDetails',
        id: channelId,
        maxResults: 1,
        key: auth.youtube_token
    })}`;
    
    makeYouTubeRequest(url, (error, data) => {
        if (error) {
            callback(error, null);
            return;
        }
        
        if (data.error) {
            callback(new Error(data.error.message), null);
            return;
        }
        
        if (!data.items || data.items.length === 0) {
            callback(new Error('Channel not found'), null);
            return;
        }
        
        const uploadsPlaylistId = data.items[0].contentDetails.relatedPlaylists.uploads;
        callback(null, uploadsPlaylistId);
    });
}

function getRecentUploads(uploadsPlaylistId, sinceDate, callback) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?${qs.stringify({
        part: 'snippet',
        playlistId: uploadsPlaylistId,
        maxResults: 25,
        key: auth.youtube_token
    })}`;
    
    makeYouTubeRequest(url, (error, data) => {
        if (error) {
            callback(error, null);
            return;
        }
        
        if (data.error) {
            callback(new Error(data.error.message), null);
            return;
        }
        
        if (!data.items) {
            callback(null, []);
            return;
        }
        
        const recentVideos = data.items.filter(item => 
            item.snippet.publishedAt >= sinceDate
        );
        
        callback(null, recentVideos);
    });
}

function checkVideoInPlaylist(videoId, targetPlaylistId, callback) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?${qs.stringify({
        part: 'snippet',
        playlistId: targetPlaylistId,
        videoId: videoId,
        maxResults: 1,
        key: auth.youtube_token
    })}`;
    
    makeYouTubeRequest(url, (error, data) => {
        if (error) {
            callback(error, null);
            return;
        }
        
        if (data.error) {
            callback(null, false);
            return;
        }
        
        const found = data.items && data.items.length > 0;
        callback(null, found ? data.items[0] : false);
    });
}

function checkForNewVideos() {
    if (!uploadPlaylistID || !playlistID || !discordChannel) {
        console.log('Not all parameters set up for check');
        return;
    }
    
    console.log('Checking for new videos...');
    
    getRecentUploads(uploadPlaylistID, lastCheck, (error, recentVideos) => {
        if (error) {
            console.error('Error getting new videos:', error.message);
            return;
        }
        
        console.log(`Found ${recentVideos.length} recent videos`);
        
        recentVideos.forEach(video => {
            const videoId = video.snippet.resourceId.videoId;
            
            checkVideoInPlaylist(videoId, playlistID, (error, videoInPlaylist) => {
                if (error) {
                    console.error('Error checking playlist:', error.message);
                    return;
                }
                
                if (videoInPlaylist) {
                    console.log('Found new video in playlist:', videoInPlaylist.snippet.title);
                    
                    const channel = client.channels.cache.get(discordChannel);
                    if (channel) {
                        const videoUrl = `https://youtu.be/${videoId}`;
                        const channelName = videoInPlaylist.snippet.videoOwnerChannelTitle || 'Unknown Channel';
                        
                        const message = `🎥 **New video added into playlist!**\n` +
                                        `**${videoInPlaylist.snippet.title}**\n` +
                                        `Channel: ${channelName}\n` +
                                        `${videoUrl}`;
                        
                        channel.send(message).catch(console.error);
                    }
                }
            });
        });
        
        lastCheck = new Date().toISOString();
    });
}


client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    
    const content = message.content.toLowerCase();
    
    if (content.startsWith('yp!set ')) {
        const playlistIdFromMessage = message.content.slice(7).trim();
        
        if (!playlistIdFromMessage) {
            message.reply('Please specify playlist ID. Example: `yp!set PLrAJxTYMBJOQISYFDNy8RwYfvpQwLOQ1Q`');
            return;
        }
        
        message.reply('⏳ Checking playlist...');
        
        getPlaylistInfo(playlistIdFromMessage, (error, playlistInfo) => {
            if (error) {
                message.reply(`❌ Error: ${error.message}`);
                return;
            }
            
            playlistID = playlistIdFromMessage;
            const channelId = playlistInfo.snippet.channelId;
            
            getUploadPlaylist(channelId, (error, uploadsPlaylistId) => {
                if (error) {
                    message.reply(`❌ Error getting channel: ${error.message}`);
                    return;
                }
                
                uploadPlaylistID = uploadsPlaylistId;
                lastCheck = new Date().toISOString();
                
                message.reply(`✅ Playlist set: **${playlistInfo.snippet.title}**\n` +
                            `Channel: ${playlistInfo.snippet.channelTitle}\n` +
                            `Every 30 minutes check activated!`)
                
                if (scheduler) {
                    clearInterval(scheduler);
                }
                scheduler = setInterval(checkForNewVideos, 30 * 60 * 1000);
            });
        });
    }
    
    else if (content === 'yp!get') {
        if (!playlistID) {
            message.reply('❌ Please before set the playlist with `yp!set [playlistId]`');
            return;
        }
        
        message.reply('⏳ Checking for new videos...');
        checkForNewVideos();
    }
    
    else if (content === 'yp!channel') {
        discordChannel = message.channel.id;
        message.reply('✅ Channel for notifications set!');
    }
    
    else if (content === 'yp!help') {
        const helpMessage = `🤖 **YouTube Playlist Bot - Commands:**\n\n` +
                          `\`yp!set [playlistId]\` - Set playlist for checking\n` +
                          `\`yp!get\` - Manual checking for new videos\n` +
                          `\`yp!channel\` - Set current channel for notifications\n` +
                          `\`yp!status\` - Show current settings\n` +
                          `\`yp!help\` - Show this message\n\n` +
                          `**How to get playlist ID:**\n` +
                          `1. Open the playlist on YouTube\n` +
                          `2. Copy ID from URL (after \`list=\`)\n` +
                          `Example: \`PLrAJxTYMBJOQISYFDNy8RwYfvpQwLOQ1Q\``;
        message.reply(helpMessage);
    }
    
    else if (content === 'yp!status') {
        let status = '📊 **Current settings:**\n\n';
        status += `Playlist: ${playlistID ? '✅ Set' : '❌ Not set'}\n`;
        status += `Notification channel: ${discordChannel ? '✅ Set' : '❌ Not set'}\n`;
        status += `Auto-check: ${scheduler ? '✅ Active (every 30 minutes)' : '❌ Inactive'}\n`;
        status += `Last check: ${lastCheck}`;  
        message.reply(status);
    }
});

client.on('ready', () => {
    console.log(`Bot ${client.user.tag} started`);
    console.log('Commands: yp!help');
});

client.on('error', console.error);

process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});

client.login(auth.discord_token);