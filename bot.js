require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ChannelType,
  ActivityType,
} = require('discord.js');
const { getVoiceConnection } = require('@discordjs/voice');
const { Streamer, VideoStream, AudioStream } = require('@dank074/discord-video-stream');
const playdl = require('play-dl');
const ffmpegPath = require('ffmpeg-static');
const { spawn } = require('child_process');
 
// ─── Client Setup ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
 
const streamer = new Streamer(client);
const activeStreams = new Map();
 
// ─── Get YouTube stream URLs ──────────────────────────────────────────────────
async function getYtInfo(url) {
  const info = await playdl.video_info(url);
  const details = info.video_details;
 
  // Get best video format (720p mp4 preferred)
  const videoFormat = info.format
    .filter((f) => f.mimeType?.includes('video') && f.url)
    .sort((a, b) => {
      const aq = parseInt(a.qualityLabel) || 0;
      const bq = parseInt(b.qualityLabel) || 0;
      return bq - aq;
    })[0];
 
  // Get best audio format
  const audioFormat = info.format
    .filter((f) => f.mimeType?.includes('audio') && f.url)
    .sort((a, b) => (b.averageBitrate || 0) - (a.averageBitrate || 0))[0];
 
  return {
    videoUrl: videoFormat?.url,
    audioUrl: audioFormat?.url,
    title: details.title,
    duration: details.durationInSec,
    isLive: details.upcoming === false && details.durationInSec === 0,
    thumbnail: details.thumbnails?.[0]?.url,
  };
}
 
// ─── Stop active stream ───────────────────────────────────────────────────────
function stopStream(guildId) {
  const state = activeStreams.get(guildId);
  if (state) {
    state.ffmpegVideo?.kill('SIGKILL');
    state.ffmpegAudio?.kill('SIGKILL');
    try { streamer.stopStream(guildId); } catch (_) {}
    try { getVoiceConnection(guildId)?.destroy(); } catch (_) {}
    activeStreams.delete(guildId);
    return true;
  }
  return false;
}
 
// ─── Stream to Discord ────────────────────────────────────────────────────────
async function streamToDiscord(guildId, channelId, videoUrl, audioUrl) {
  await streamer.joinVoice(guildId, channelId);
  const udpConn = await streamer.createStream(guildId);
 
  udpConn.mediaConnection.setSpeaking(true);
  udpConn.mediaConnection.setVideoStatus(true);
 
  // Video FFmpeg process
  const ffmpegVideo = spawn(ffmpegPath, [
    '-re', '-loglevel', 'error',
    '-i', videoUrl,
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-tune', 'zerolatency',
    '-b:v', '2500k',
    '-pix_fmt', 'yuv420p',
    '-an',
    '-f', 'rawvideo',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
 
  ffmpegVideo.stderr.on('data', (d) => process.stderr.write(`[FFmpeg Video] ${d}`));
 
  const videoStream = new VideoStream(udpConn, 30, 1000 / 30);
  ffmpegVideo.stdout.pipe(videoStream);
 
  // Audio FFmpeg process
  const ffmpegAudio = spawn(ffmpegPath, [
    '-re', '-loglevel', 'error',
    '-i', audioUrl || videoUrl,
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '2',
    '-vn',
    '-f', 's16le',
    'pipe:1',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
 
  ffmpegAudio.stderr.on('data', (d) => process.stderr.write(`[FFmpeg Audio] ${d}`));
 
  const audioStream = new AudioStream(udpConn);
  ffmpegAudio.stdout.pipe(audioStream);
 
  ffmpegVideo.on('close', () => stopStream(guildId));
 
  return { ffmpegVideo, ffmpegAudio };
}
 
// ─── Format duration ──────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s]
    .map((v, i) => (i === 0 && v === 0 ? null : String(v).padStart(2, '0')))
    .filter(Boolean)
    .join(':');
}
 
// ─── Commands ─────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guildId, member } = interaction;
 
  if (commandName === 'play') {
    const url = interaction.options.getString('url');
    const voiceChannel = member?.voice?.channel;
 
    if (!voiceChannel)
      return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
 
    if (voiceChannel.type !== ChannelType.GuildVoice)
      return interaction.reply({ content: '❌ Must be in a regular voice channel.', ephemeral: true });
 
    await interaction.deferReply();
    stopStream(guildId);
 
    try {
      await interaction.editReply('🔍 Fetching video info...');
      const info = await getYtInfo(url);
 
      if (!info.videoUrl)
        return interaction.editReply('❌ Could not extract a video stream from that URL.');
 
      await interaction.editReply(
        `▶️ Starting: **${info.title}**\n📡 Joining <#${voiceChannel.id}>...`
      );
 
      const { ffmpegVideo, ffmpegAudio } = await streamToDiscord(
        guildId, voiceChannel.id, info.videoUrl, info.audioUrl
      );
 
      activeStreams.set(guildId, { ffmpegVideo, ffmpegAudio, title: info.title });
 
      await interaction.editReply(
        `✅ Streaming: **${info.title}**\n` +
        `${info.isLive ? '🔴 Live' : `⏱️ ${formatDuration(info.duration)}`}\n` +
        `Use \`/stop\` to end.`
      );
    } catch (err) {
      console.error('[Play Error]', err);
      stopStream(guildId);
      await interaction.editReply(`❌ Error: \`${err.message}\``);
    }
  }
 
  if (commandName === 'stop') {
    const stopped = stopStream(guildId);
    await interaction.reply(stopped ? '⏹️ Stream stopped.' : { content: '❌ Nothing is playing.', ephemeral: true });
  }
 
  if (commandName === 'nowplaying') {
    const state = activeStreams.get(guildId);
    await interaction.reply(
      state ? `🎬 Now streaming: **${state.title}**` : { content: '❌ Nothing is playing.', ephemeral: true }
    );
  }
});
 
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('YouTube 📺', { type: ActivityType.Watching });
});
 
process.on('SIGINT', () => {
  for (const [id] of activeStreams) stopStream(id);
  client.destroy();
  process.exit(0);
});
 
client.login(process.env.DISCORD_TOKEN);
 
