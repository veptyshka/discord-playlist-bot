const { Client, GatewayIntentBits } = require('discord.js');
const https = require('https');
const qs = require('querystring');
const auth = require('./auth.json');
const { error } = require('console');


const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

let playListID = null;
let uploadPlayListID = null;
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

function getPlayListInfo(playListId, callback) {
    const url = `https://www.googleapis.com/youtube/v3/playlists?${qs.stringify({
        part: 'snippet',
        id: playListId,
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

function getUploadPlayList(channelId, callback) {
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

        const uploadsPlayListId = data.items[0].contentDetails.relatedPlaylists.uploads;
        callback(null, uploadsPlayListId);
    });
}

function getRecentUploads(uploadsPlayListId, sinceDate, callback) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?${qs.stringify({
        part: 'snippet',
        playListId: uploadsPlayListId,
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
        
        // Фильтруем видео, добавленные после lastCheck
        const recentVideos = data.items.filter(item => 
            item.snippet.publishedAt >= sinceDate
        );
        
        callback(null, recentVideos);
    });
}

function checkVideoInPlayList(videoId, targetPlayListId, callback) {
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
    if (!uploadPlayListID || !playListID || !discordChannel) {
        console.log('Not all parameters set up for check');
        return;
    }

    console.log('Checking for new videos...');

    getRecentUploads(uploadPlayListID, lastCheck, (error, recentVideos) => {
        if (error) {
            console.error('Error getting new videos:', error.message);
            return;
        }

        console.log(`Found ${recentVideos.length} recent videos`);

        recentVideos.forEach(video => {
            const videoId = video.snippet.resourceId.videoId;

            checkVideoInPlayList(videoId, playListID, (error, videoInPlayList) => {
                if (error) {
                    console.error('Error checking playlist:', error.message);
                    return;
                }

                if (videoInPlayList) {
                    console.log('Found new video in playlist:', videoInPlayList.snippet.title);

                    const channel = client.channels.cache.get(discordChannel);
                    if (channel) {
                        const videoUrl = `https://youtu.be/${videoId}`;
                        const channelName = videoInPlayList.snippet.videoOwnerChannelTitle || 'Unknown channel';

                        const message = `🎥 **New video added into playlist!**\n` +
                                        `**${videoInPlayList.snippet.title}**\n` +
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
        const newPlayListId = message.content.slice(7).trim();

        if (!newPlayListId) {
            message.reply('Please specify playlist ID. Example: `yp!set PLrAJxTYMBJOQISYFDNy8RwYfvpQwLOQ1Q`');
            return;
        }

        message.reply('⏳ Checking playlist...');

        getPlayListInfo(newPlayListID, (error, playListInfo) => {
            if (error) {
                message.reply(`❌ Error: ${error.message}`);   
                return;
            }

            playListID = newPlayListID;
            const channelId = playListInfo.snippet.channelId;

            getUploadPlayList(channelId, (error, uploadPlayListId) => {
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
        if (!playListID) {
            message.reply('❌ Please before set the playlist with `yp!set [playlistId]`');
            return;
        }

        message.reply('⏳ Checking for new videos...');
        checkForNewVideos();
    }

    else if (content === 'yp!channel') {
        discordChannel === message.channel.id;
        message.reply('✅ Channel for notifications set!')
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

client.login(auth.discord_token)