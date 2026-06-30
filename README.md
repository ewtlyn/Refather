# Anonymous Bot Constructor

A Telegram bot for creating anonymous chat bots — a Refather-like service. Lets a user spin up their own anonymous bot in a few steps, with no coding required.

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-003B57?style=for-the-badge&logo=sqlite&logoColor=white)
![Telegram](https://img.shields.io/badge/Telegram%20Bot%20API-26A5E4?style=for-the-badge&logo=telegram&logoColor=white)

---

## About

The bot lets anyone create their own anonymous Telegram bot through a conversation with the main constructor bot: provide a token from @BotFather and get a ready-made anonymous bot with its own messaging logic — no server setup or coding needed.

The project was built on a custom development contract and is fully complete, but was never handed off to the client — it's published here as a finished, working product for the portfolio.

## Features

- Create a new anonymous bot using a token from @BotFather
- Manage multiple bots from a single account
- Anonymous messaging between users of the created bot
- Bot-to-owner binding and state stored in SQLite

## Tech Stack

- **Backend:** Node.js
- **Database:** SQLite
- **Integration:** Telegram Bot API (dynamic bot registration using a user-provided token)

## Architecture

The main constructor bot accepts a user's token and spins up a separate bot instance for them programmatically (without restarting the whole service), storing the `owner → token → bot` binding in the database. Each created bot runs independently and handles anonymous messaging between its own users.

```
.
├── index.js         ← main constructor bot, handles bot creation
├── botManager.js     ← dynamic start/stop of created bot instances
├── db.js             ← SQLite connection, bot storage schema
└── .env.example
```

> Update the structure above if your actual file names differ.

## Running locally

```bash
git clone https://github.com/<your-username>/anon-bot-constructor.git
cd anon-bot-constructor
npm install
```

Create a `.env` file:

```
MAIN_BOT_TOKEN=your_main_bot_token_from_BotFather
```

Run:

```bash
node index.js
```

## Status

Fully implemented and tested. Not currently in production — available here as a demonstration of the engineering solution.
