require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Join your voice channel and stream a YouTube video or live stream')
    .addStringOption((opt) =>
      opt
        .setName('url')
        .setDescription('YouTube video or live stream URL')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop the current stream and disconnect the bot'),

  new SlashCommandBuilder()
    .setName('nowplaying')
    .setDescription('Show what is currently streaming'),
].map((cmd) => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log('🔄 Registering slash commands...');

    // Guild-specific (instant update) — replace with your guild ID
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log(`✅ Commands registered for guild ${process.env.GUILD_ID}`);
    } else {
      // Global (takes up to 1 hour to propagate)
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), {
        body: commands,
      });
      console.log('✅ Global commands registered (may take up to 1 hour)');
    }
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
})();
