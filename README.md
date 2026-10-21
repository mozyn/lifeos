# LifeOS

LifeOS is a calm, private planner for your phone and computer: your day (morning, midday and
evening), your week, your goals, your habits and your lists, with prayer times and the Hijri date.
It works on **a folder of plain .md files you can open in any editor; Obsidian is optional and
nice, not required.** Those files are the only copy of your data: LifeOS reads them and makes only
small, careful changes (a ticked box, a new task, a log line), so you can keep editing them
yourself. It runs on your own computer with Docker. There is no account and no cloud, and nothing
is sent anywhere unless you turn it on (see "What leaves your computer").

What it does:

- **Today**: what is due, the next prayer, a short plan for the day, a check-in, and a small
  reward when you finish something.
- **Calendar**: day, week and month, with events, tasks, prayer times and the Hijri date.
- **Goals and habits**: goals with their tasks, habits to build or to quit, with streaks.
- **Lists**: tasks, notes, links, shopping and a wishlist; a web search you can file results from.
- **Reminders**: in the app, as browser notifications, and (if you like) as Telegram messages.
- **AI drafts (optional)**: Hermes, your own AI agent (recommended, see "Connect Hermes"), or a
  model you choose can draft the morning plan and the evening review; you approve each one.
  Without one, LifeOS drafts them plainly from your tasks and times.

## Quick start (from GitHub)

```sh
git clone https://github.com/mozyn/lifeos
cd lifeos
# set LIFEOS_VAULT_HOST in .env to your notes folder (or just run ./install.sh and answer)
docker compose up -d
```

Then open `http://localhost:8480/lifeos`. Everything else is in the sections below.

## What you need

- **Docker**: Docker Desktop (Windows, macOS) or Docker Engine with Compose (Linux), or a NAS
  with Docker and Dockge (ZimaOS, TrueNAS, Unraid; see "Install on a NAS"). Intel/AMD or ARM
  (64-bit). https://docs.docker.com/get-docker/ . About 1 GB of memory for LifeOS itself.
- **A notes folder**: an Obsidian vault, any folder of `.md` files, or the starter notes that
  come with LifeOS.
- Optional: **Hermes**, an AI agent you run yourself, for the AI drafts, adding tasks from chat
  and Telegram reminders (recommended); or instead **a model** for the AI drafts (llama.cpp,
  Ollama, LM Studio, vLLM on your computer, or a cloud provider) and **a Telegram bot** for
  reminders; and **Tailscale** (free) to open LifeOS on your phone over HTTPS.

## Install on a computer, in five steps

(On a NAS, or anywhere with Dockge: see "Install on a NAS" below. No installer is needed there.)

1. Copy this folder anywhere on the computer that will run LifeOS (for example your home folder).
2. Start Docker Desktop (or make sure Docker is running).
3. Open a terminal in this folder and run `./install.sh` (Linux, macOS). On Windows, open
   PowerShell in this folder and run `powershell -ExecutionPolicy Bypass -File .\install.ps1`
   (or run `./install.sh` inside WSL).
4. Answer its questions: use a notes folder you already have, or make a new one for the starter
   notes (LifeOS puts them in an empty folder when it first starts). It also asks, if you want,
   for a model on your computer and a Telegram bot. It downloads LifeOS's images (a few minutes
   the first time) and prints the address.
5. Open **http://localhost:8480/lifeos/**, choose a passphrase (the only key to LifeOS), then tell
   it where you are: a city from its built-in list (nothing is looked up online), or coordinates.

Stop it with `docker compose -p lifeos stop`, start it again with `docker compose -p lifeos up -d`.
It also starts by itself when Docker starts.

## Install on a NAS (Dockge, ZimaOS, TrueNAS, Unraid)

No installer and no shell: the folder's `compose.yaml` pulls LifeOS's three images from GitHub's
container registry (nothing is built on the NAS), and on its first start LifeOS makes its own
secrets and puts the starter notes in an empty notes folder. You set three values and press
Deploy.

You need **Dockge** (an app in the ZimaOS App Store, the TrueNAS Apps catalog and Unraid's
Community Applications), a folder on the NAS for your notes (empty, or your existing notes), and
about 1 GB of memory free while it downloads the images.

### Dockge, step by step

1. In Dockge, press **+ Compose**, type `lifeos` as the stack name, and press **Save**. Dockge
   makes the stack's folder: `/opt/stacks/lifeos` (ZimaOS: `/DATA/AppData/dockge/stacks/lifeos`;
   TrueNAS: `lifeos` in the dataset you gave Dockge for its stacks).
2. Copy everything in this LifeOS folder into that folder, over SMB (a network share) or the NAS's
   Files app, replacing the `compose.yaml` Dockge wrote. Copy the whole folder's contents,
   including the file named `.env` (macOS and some file managers hide names starting with a dot;
   they are copied all the same).
3. Back in Dockge, open the `lifeos` stack (reload the page first) and press **Edit**. In the
   **.env** box, set:
   - `LIFEOS_VAULT_HOST`: your notes folder on the NAS, for example `/DATA/Documents/Notes`
     (ZimaOS), `/mnt/<pool>/notes` (TrueNAS) or `/mnt/user/notes` (Unraid). An empty folder gets
     the starter notes on the first start; a folder with anything in it is never changed that way.
   - `LIFEOS_BIND=0.0.0.0`, so your phone and computers on the home network can open it.
   - `LIFEOS_UID` and `LIFEOS_GID`: the owner of the notes folder, whom LifeOS writes as. ZimaOS:
     usually `1000` and `1000`. TrueNAS: the apps user, `568` and `568` (or the dataset's owner).
     Unraid: `99` and `100`. Not sure? Deploy with the defaults: if LifeOS cannot write the
     folder, the `lifeos-api` log in Dockge says so and names the owner it found.
   - Optional: `TZ`, your time zone (for example `America/Toronto`), so the starter notes are
     dated your today; the first run asks where you are anyway.
4. Press **Deploy**. The first run downloads the images (a few minutes); the three
   containers then turn **healthy**.
5. Open **`http://<nas-ip>:8480/lifeos`** (for example `http://192.168.1.20:8480/lifeos`), choose a
   passphrase, then tell it where you are. It says once that plain http cannot install the app or
   send notifications: see "HTTPS on a NAS" below. Put the address you open in `.env` as
   `LIFEOS_PUBLIC_URL` (reminder links and the Hermes prompt use it) and Deploy again.

Keep the stack's name and `LIFEOS_NAME` (in `.env`, `lifeos` unless you change it) the same, so
Dockge shows the stack as running. Port 8480 taken? Set `LIFEOS_PORT` to a free one.

### Without Dockge

- **A shell on the NAS** (SSH, or the NAS's own terminal), anywhere: copy the folder, set the
  same three values in its `.env`, then in the folder run `docker compose up -d`.
- **ZimaOS, without Dockge**: App Store → **Install a customized app** (the **+** at the top) →
  **Import** → paste `compose.yaml`. It does not read this folder's `.env` and keeps the compose
  file elsewhere: paste the values from this folder's `.env` where the `${LIFEOS_…}` are (the
  compose now pulls its images, so nothing else in the folder is needed). Dockge does all of
  that for you.
- **TrueNAS Apps, "Install via YAML" (a custom app)**: it can pull the images, so this may work
  now — but the simplest path is still Dockge (from the TrueNAS Apps catalog) or a shell.
- **Portainer**: **Stacks → Add stack** (web editor, upload or repository) now carries the
  compose with nothing beside it: paste the compose, set the values, deploy. Portainer then
  shows and manages the running containers.
- **Unraid**: Dockge from Community Applications as above, or the Docker Compose Manager plugin
  pointed at this folder.

### HTTPS on a NAS

The phone installs LifeOS as an app, and gets notifications, only from an https address. Plain
`http://<nas-ip>:8480` works for everything else. Three ways to https:

- **Tailscale Serve** (simplest; ZimaOS and TrueNAS both have a Tailscale app, Unraid a plugin).
  With Tailscale on the NAS (on the host network) and on your phone, run in the NAS's Tailscale
  shell `tailscale serve --bg --set-path /lifeos http://127.0.0.1:8480` and open
  `https://<nas-name>.<your-tailnet>.ts.net/lifeos` on the phone. Nothing is opened to the
  internet, and `LIFEOS_BIND` can go back to `127.0.0.1` if only Tailscale should reach it.
- **Your NAS's reverse proxy** (Nginx Proxy Manager, Caddy, Traefik, the NAS's own), with a
  certificate for a name you own. LifeOS lives under `/lifeos`; the proxy must keep the `Host`
  header and say it was https. Nginx (in Nginx Proxy Manager: a Proxy Host's **Advanced** box):
  ```
  location /lifeos/ {
      proxy_pass http://192.168.1.20:8480;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_read_timeout 180s;
  }
  ```
  Caddy (a `Caddyfile`; Caddy gets the certificate itself):
  ```
  nas.example.com {
      handle /lifeos* {
          reverse_proxy 192.168.1.20:8480
      }
  }
  ```
  A proxy in Docker on the NAS reaches LifeOS at the NAS's address, so keep `LIFEOS_BIND=0.0.0.0`.
- **A local certificate** (for example from `mkcert`) on such a proxy, with its root installed on
  each phone and computer: https without a domain or Tailscale, more work per device.

Then set `LIFEOS_PUBLIC_URL` to the https address (for example
`https://nas-name.your-tailnet.ts.net/lifeos`) and Deploy again.

### Updating on a NAS

The images are tagged, so an update is a pull: in `.env` set `LIFEOS_IMAGE_TAG` to the new tag
(see the tags on the GitHub releases page), or leave it empty to take `latest`. Then in Dockge
press **Deploy** (or in a shell run `docker compose pull && docker compose up -d`). If you got a
new LifeOS folder, replace `compose.yaml` and `README.md` with the new ones. Keep `.env` and any
other `.env.…` files: they are your settings. Your notes, passphrase and LifeOS's database stay.
Settings that are new in a version have defaults; compare the new folder's `.env` with yours to
see them.

## On your phone

A phone needs an HTTPS address to install LifeOS as an app (and to get notifications). The
simplest way is [Tailscale](https://tailscale.com) on the computer and on the phone, then, on the
computer: `tailscale serve --bg --set-path /lifeos http://127.0.0.1:8480`. Open
`https://<your-computer>.<your-tailnet>.ts.net/lifeos` on the phone and choose **Add to Home
screen** (Chrome) or **Share → Add to Home Screen** (Safari). Put that address in `.env` as
`LIFEOS_PUBLIC_URL` so reminder links open it. Any other reverse proxy that serves
`https://…/lifeos/` from `http://127.0.0.1:8480/lifeos/` works too.

(Setting `LIFEOS_BIND=0.0.0.0` in `.env` lets every device on your home network open
`http://<computer>:8480/lifeos/`, passphrase protected, but as a plain website: no app on the home
screen and no notifications. "HTTPS on a NAS" above has the ways to https for that address too.)

## Connect Hermes (recommended)

[Hermes](https://hermes-agent.nousresearch.com/) is an AI agent you run yourself, with its own
memory, schedules and chat apps. Connected to LifeOS it becomes LifeOS's main helper: it drafts
your morning plan, evening review and habit encouragement with its model (you approve each one in
LifeOS), adds tasks, reminders and notes when you ask it in chat, tells you how your day or week
looks, and sends your reminders to you on Telegram.

1. Install Hermes and set it up (its own guide, at the link above).
2. In LifeOS, open **Settings → Hermes** and tap **Create token**.
3. Tap **Copy**, paste the text into your Hermes chat, and answer its questions. Hermes finds
   LifeOS, saves the connection, schedules the drafts and the reminders, helps you set up
   Telegram if it is not set up yet, and reports back with a test reminder.

**Use a local model in Hermes.** Hermes uses whatever model it is set to. For full privacy make
sure it is on a local model (its model setting); with a cloud model, your notes in the prompt
leave your machine. LifeOS itself calls no model while Hermes writes the drafts: Hermes asks
LifeOS, with a token you can revoke in Settings → Hermes at any time, and every call it makes is
in Settings → Privacy → the connection log.

**Telegram is Hermes's job then:** nothing to set up in LifeOS (the Telegram bot under
Reminders is for people without Hermes).

**Hermes in Docker on the same computer.** The prompt has Hermes try `http://lifeos-api:8481`
first: LifeOS's API container on its Docker network, `lifeos-net` (both named after `LIFEOS_NAME`
in `.env`). Put Hermes's container on that network once, with
`docker network connect lifeos-net <hermes container>` (Hermes can do it itself if it may run
`docker`). Hermes running directly on the computer uses `http://localhost:8480/lifeos`; on
another machine, the HTTPS address from "On your phone" (set it as `LIFEOS_PUBLIC_URL`).

## Reminders

A task with a time (`⏰ 09:00`, or `⏰ maghrib+30` after a prayer) is a reminder. In
**Settings → Reminders**:

- **In-app**: always on. Due and overdue tasks show on Today.
- **Browser notifications**: turn on per device. One notification per reminder, quiet hours
  respected. Needs the HTTPS address (or `localhost` on the computer itself); on an iPhone, open
  LifeOS from its Home Screen icon first.
- **Telegram**: through Hermes (see "Connect Hermes"). Without Hermes, LifeOS's own bot can send
  them (Settings → Advanced settings → Telegram bot):
  1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the token it gives you.
  2. Send your new bot any message, then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `"chat":{"id": …}`.
  3. Put both in a file named `.env.telegram` in this folder:
     ```
     TELEGRAM_BOT_TOKEN=123456789:AAE…
     TELEGRAM_CHAT_ID=123456789
     ```
     (In a group with topics, add `TELEGRAM_THREAD_ID=<topic id>`.) Then run
     `docker compose -p lifeos up -d`.

## AI drafts: bring your own model

**Settings → Advanced settings → AI** (also asked on the first run; Off by default):

- **Off**: plain drafts from your tasks, events and prayer times. Nothing is sent.
- **Hermes**: your Hermes agent writes the drafts with its own model (see "Connect Hermes"; this
  is chosen for you when you create its token). If Hermes has not answered within two minutes,
  the plain draft shows, and Hermes's takes its place when it comes.
- **Local** (recommended: nothing leaves your machine): any OpenAI-compatible server on your
  computer or network, such as llama.cpp's `llama-server`, Ollama, LM Studio or vLLM. From inside
  Docker your computer is `host.docker.internal`, so for Ollama the address is
  `http://host.docker.internal:11434/v1` and the model is the name you pulled (for example
  `llama3.1:8b`). To set it at install time instead, put this in a file named `.env.ai`:
  ```
  AI_PROVIDER=local
  AI_BASE_URL=http://host.docker.internal:11434/v1
  AI_MODEL=llama3.1:8b
  AI_API_KEY=
  ```
  (LM Studio: `http://host.docker.internal:1234/v1`; llama.cpp: `http://host.docker.internal:8080/v1`.)
- **OpenAI**, **Anthropic Claude**, or **another cloud service** (any OpenAI-compatible
  provider): your API key and a model. Anthropic starts with `claude-opus-5-5`; change it to a
  cheaper model if you like. In `.env.ai`: `AI_PROVIDER=openai` (or `anthropic`), `AI_MODEL=…`,
  `AI_API_KEY=…`; for another service also `AI_PROVIDER=other` and `AI_BASE_URL=https://…/v1`.

**A warning you will see with a cloud provider:** *"Your notes, tasks and habit logs in the
prompt will be sent to <provider>. Use a local model to keep everything private."* It is shown
when you choose one, in Settings → Privacy, and again on Today before the first draft: nothing is
sent until you say so there. Only the provider's address is allowed out, and every call is listed
in the connection log (Settings → Privacy). Keys are kept in `.env.ai` (set at install,
readable only by you) or in LifeOS's own settings (set in Settings); never in your notes, never
shown again, never logged.

**A subscription instead of an API key** (Claude.ai, ChatGPT): LifeOS does not log in to those
itself. If you run an OpenAI-compatible proxy that holds your login (for example Hermes's
`api_server`, or a similar tool), point **Local** at it. The warning above then applies even
though LifeOS cannot tell: your prompts go wherever that proxy sends them.

## What leaves your computer

Nothing about you, unless you turn it on:

- **Web search** (Lists and Quick Add, when you search): only the words you type, to LifeOS's own
  search container (SearXNG), which asks public search engines. Settings → Privacy turns it off.
- **Telegram**, if you set it up: your reminders.
- **Hermes**, if you connect it: it asks LifeOS for your day (tasks, events, habits, captures,
  goals, prayer times; a private habit only as "private habit P1") and for your reminders, with
  its token. That stays on your computer or network unless Hermes runs on a cloud model.
- **Browser notifications**, if you turn them on: your reminders, encrypted for your device; your
  browser maker's push service (Google, Mozilla or Apple) carries them without being able to read
  them.
- **The model**, if it is not on your computer or network: the prompts (with the warning above).
- **Prayer times**, if you allow the one online comparison: the date and your rounded coordinates
  to api.aladhan.com, once, when you ask.

Everything else (your place, your notes, your habits) stays here. The app itself loads nothing
from the internet: no fonts, no analytics, no maps.

## Backup

Your notes folder is your data: back it up like any folder (or sync it with Syncthing, iCloud
Drive, Dropbox…). LifeOS's database (a Docker volume, `lifeos-data`) is only an index of the notes
plus your settings, drafts and passphrase, and rebuilds itself from the notes. Keep a copy of this
folder's `.env` files if you want your settings back after reinstalling.

## Update and uninstall

- **Update**: get the new LifeOS folder, then in this one run
  `./update.sh /path/to/the/new/lifeos-portable` (a folder, a `.tar.gz`, or an https link to one).
  Your settings, passphrase, database and notes stay. (On a NAS: "Updating on a NAS".)
- **Uninstall**: `./uninstall.sh` stops LifeOS and removes its containers; it asks before deleting
  its database. Your notes are never touched.

## Your notes folder

LifeOS uses these folders (it makes them when it needs them):

- `Daily Notes/2026-10-20.md`: a day, with **Plan**, **Tasks** and **Notes**. LifeOS adds
  Check-in, Mood and Review when you use them.
- `Weekly Notes/2026-W43.md`: a week, with each day's events under it:
  `- Wed 10-22` and under it `  - 19:00 Dinner with friends`.
- `Areas/Habits/<name>.md`, `Areas/Goals/<name>.md`, `Areas/Lists/shopping.md` and `wishlist.md`.
- `Resources/links.md` for links; `Resources/hadith-library/` for the hadith reminders (included
  in the starter notes; to have them in your own folder, copy
  `src/fixtures/starter-vault/Resources/hadith-library` from this folder into it).
- `Inbox/` for new notes, `Archive/` for what you archive (nothing is ever deleted), `Templates/
  Daily Note.md` for the shape of a new day.

A task is any line like `- [ ] Call the dentist 📅 2026-10-23 ⏰ 09:00 #health`: `📅` the day
it is due, `⏰` a reminder, `🔁 every week` to repeat it, `⏫` for high priority, `@goal-name` to
count it toward a goal. These are the same marks as Obsidian's Tasks plugin. LifeOS only ever
changes the one line it is working on, and refuses (rather than guesses) if the line has moved.

Why no database of its own for your data? The folder already is a complete, readable store that
any editor and any backup tool understands, and LifeOS's database is rebuilt from it at any time.

## Trouble?

- **"Port 8480 is in use"**: set `LIFEOS_PORT=8490` (any free port) in `.env`, then
  `docker compose -p lifeos up -d`; open `http://localhost:8490/lifeos/`.
- **"is not writable" or notes do not change**: LifeOS writes your notes as the user in `.env`
  (`LIFEOS_UID`, `LIFEOS_GID`; install.sh fills them in from `id -u` and `id -g`). Set them to the
  notes folder's owner: the `api` container's log says at start whom it found (in Dockge, the
  stack's log; in a shell, `docker compose -p lifeos logs api`). On a NAS see step 3 of "Dockge,
  step by step".
- **The starter notes did not appear**: they go only into a folder that is empty (what a NAS
  leaves, like `.DS_Store` or `@eaDir`, does not count) on LifeOS's very first start;
  `LIFEOS_STARTER=off` turns them off. A folder that did not exist when you deployed is made by
  Docker, empty and owned by root: make the folder yourself, then deploy again.
- **Is it running?** `docker compose -p lifeos ps` shows three containers, each "healthy";
  `curl http://localhost:8480/lifeos/api/health` answers `{"ok":true,…}`. Logs:
  `docker compose -p lifeos logs api`.
- **Forgot the passphrase**: delete the file `.env.auth`; the next visit asks for a new one. It is in
  LifeOS's data volume: `docker compose -p lifeos exec api rm /auth/.env.auth` (Dockge: the
  `lifeos-api` container's terminal button, then `rm /auth/.env.auth`). If `.env` sets
  `LIFEOS_AUTH_DIR`, it is in that folder instead.
- **The AI draft says "Drafted without the model"**: open it to see why (the model is off, busy,
  or waiting for your OK); Settings → Advanced → AI has "Check the connection".

LifeOS is shared for personal use; see LICENSE.
