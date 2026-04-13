# Jetstream Local Setup Guide

Run Jetstream locally using **Podman Desktop**. Works on macOS and Windows.

---

## Before You Start

You need two things before running the setup:

1. **Podman Desktop** — install from [podman-desktop.io](https://podman-desktop.io)
2. **Salesforce OAuth credentials** (Consumer Key and Consumer Secret) — stored in the **shared 1Password vault under "Jetstream Local Credentials"**

The Zscaler certificate is already included in the repository.

---

## Setup (One-Time)

### Step 1: Install and Configure Podman Desktop

#### 1a. Install Podman Desktop

Download from [podman-desktop.io](https://podman-desktop.io) or install from **Iru Self Service**.

**macOS:** Open the `.dmg` file and drag Podman Desktop to the Applications folder.

**Windows:** Run the installer `.exe` and follow the prompts with default settings.

#### 1b. Launch and Initialize the Podman Machine

1. Open **Podman Desktop**
2. On first launch, you'll see a welcome screen. Click **Next** / **Continue** through the intro screens.
3. Podman Desktop will prompt you to **initialize a Podman machine**. This is a lightweight Linux VM that runs containers.
4. **Important — set the memory to 6 GB (6144 MB) or higher:**
   - On the machine creation screen, look for the **Memory** slider or input field
   - The default is typically **4 GB (4096 MB)** — this is **not enough** for building Jetstream
   - Set it to **6 GB (6144 MB)** or higher (8 GB is fine if your machine has 16+ GB of RAM)
   - Leave CPU and Disk Size at their defaults (or increase if you prefer)
5. Click **Create** (or **Initialize**) and wait for the machine to be created
6. The machine will start automatically. Wait until you see a **green "Running"** status in the bottom-left corner of Podman Desktop

> **If you missed the memory setting or need to change it later:**
> 1. In Podman Desktop, go to **Settings > Resources**
> 2. Find your Podman machine and click the **Stop** button (square icon)
> 3. Once stopped, click the **Edit** button (pencil icon)
> 4. Change Memory to **6144 MB** or higher
> 5. Click **Save**, then click **Start** (play icon)
>
> Or use the terminal:
> ```bash
> podman machine stop
> podman machine set --memory 6144
> podman machine start
> ```

#### 1c. Configure Podman Desktop Settings

Once the machine is running, configure these settings so Podman starts automatically:

1. Click the **gear icon** (⚙️) in the bottom-left corner to open **Settings**
2. Go to **Preferences** (or **Settings > Preferences**)
3. Find and enable these options:
   - **Autostart Podman engine** — starts the Podman machine automatically when Podman Desktop opens
   - **Start Podman Desktop on login** (if available) — launches Podman Desktop when you log into your computer
4. Close the Settings panel

#### 1d. Verify Podman is Working

You should see in the Podman Desktop dashboard:
- **Podman machine**: green "Running" status
- **No error banners** at the top of the window

> **If Podman Desktop gets stuck on "Podman Machine is starting":** Close it completely, open Terminal (macOS) or PowerShell (Windows), run `podman machine start`, then reopen Podman Desktop.

### Step 2: Install Git (if you don't have it)

**macOS:**
```bash
git --version
```
If prompted, click **Install** to install Xcode Command Line Tools.

**Windows:**
Download from [git-scm.com](https://git-scm.com/download/win) and install with default settings.

### Step 3: Clone the repository

**macOS** (Terminal):
```bash
cd ~/Documents
git clone https://github.com/jetstreamapp/jetstream.git
cd jetstream
```

**Windows** (PowerShell):
```powershell
cd $HOME\Documents
git clone https://github.com/jetstreamapp/jetstream.git
cd jetstream
```

### Step 4: Run the setup script

The setup script handles the remaining configuration automatically: installing the Zscaler certificate into the Podman machine, fixing DNS if needed, prompting for Salesforce credentials, building Jetstream, and starting it. It will also verify your Podman machine memory and increase it if needed.

**macOS** (Terminal):
```bash
cd ~/Documents/jetstream
./scripts/podman-setup-mac.sh
```

**Windows** (PowerShell):
```powershell
cd $HOME\Documents\jetstream
.\scripts\podman-setup-windows.ps1
```

When prompted for Salesforce credentials, paste the **Consumer Key** and **Consumer Secret** from the shared 1Password vault under "Jetstream Local Credentials" (entry: "Jetstream Local Credentials").

The build takes **15-20 minutes** the first time. Once it finishes, Jetstream will start automatically.

### Step 5: Open Jetstream

Go to: **http://localhost:3333/app**

Login:
- **Email:** `test@example.com`
- **Password:** `EXAMPLE_123!`

To connect a Salesforce org, click **Add Org** and log in with your Salesforce credentials.

---

## Daily Usage (after sleep, restart, or shutdown)

After your machine wakes from sleep or restarts, run the start script. It automatically ensures the Podman machine is running and fixes DNS if needed.

### Starting Jetstream

**macOS** (Terminal):
```bash
cd ~/Documents/jetstream
./scripts/podman-start-mac.sh
```

**Windows** (PowerShell):
```powershell
cd $HOME\Documents\jetstream
.\scripts\podman-start-windows.ps1
```

Then open **http://localhost:3333/app**.

### Stopping Jetstream

Jetstream runs in the background — you can close the terminal after starting it. To stop it:

```bash
cd ~/Documents/jetstream
podman compose down
```

---

## Updating Jetstream

When there's a new version:

```bash
cd ~/Documents/jetstream
podman compose down
git pull
podman build --no-cache -t jetstream-app .
podman compose up -d
```

---

## Troubleshooting

### Common Errors

| Error | Fix |
|---|---|
| `x509: certificate signed by unknown authority` | Zscaler cert not in Podman VM. Re-run the setup script. |
| `unable to get local issuer certificate` | `ZscalerRoot-FullBundle.pem` missing from project folder. Run `git pull` to get it. |
| `getaddrinfo ENOTFOUND github.com` | DNS broken. Run: `podman machine ssh "echo 'nameserver 8.8.8.8' \| sudo tee -a /etc/resolv.conf"` |
| Build silently fails at "rendering chunks..." | Out of memory. Increase Podman machine memory to 6 GB: In Podman Desktop go to **Settings > Resources**, stop the machine, edit memory to **6144 MB**, save, and start. Or run: `podman machine stop && podman machine set --memory 6144 && podman machine start` |
| `invalid_client_id` when adding a Salesforce org | Wrong OAuth credentials. Check the Consumer Key in `.env` matches the 1Password vault ("Jetstream Local Credentials"). |
| `podman compose: command not found` | Podman Desktop may need to be restarted, or use `podman-compose` instead. |

### "Cannot connect to Podman" or "Podman machine not running"

Open Podman Desktop and make sure the machine is running (green status). Or run:
```bash
podman machine start
```

### Podman Desktop stuck on "starting"

Close Podman Desktop, run `podman machine start` in Terminal/PowerShell, then reopen Podman Desktop.

### Port 3333 already in use

Another app is using port 3333. Stop it, or change the port in `docker-compose.yml`:
```yaml
ports:
  - '9999:3333'
```
Then access Jetstream at `http://localhost:9999`.

### Resetting everything

If things are in a bad state:

```bash
cd ~/Documents/jetstream
podman compose down
podman system prune -a -f
podman volume prune -f
podman build --no-cache -t jetstream-app .
podman compose up -d
```

> **Warning:** This deletes all local data and starts fresh.

---

## Quick Reference

| Action | Command |
|---|---|
| Start Jetstream | `podman compose up -d` |
| Stop Jetstream | `podman compose down` |
| View logs | `podman compose logs -f` |
| Rebuild after update | `podman build --no-cache -t jetstream-app .` |
| Free disk space | `podman system prune -a -f` |

| Info | Value |
|---|---|
| App URL | http://localhost:3333/app |
| Login email | test@example.com |
| Login password | EXAMPLE_123! |
| Salesforce credentials | Shared 1Password vault |

---

For questions or help with setup, contact **Sriganesh Gopal**.
