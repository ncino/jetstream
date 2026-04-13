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

### Step 1: Install Podman Desktop

1. Download from [podman-desktop.io](https://podman-desktop.io)
2. Install and launch it
3. When prompted, initialize the Podman machine and wait for it to start (green "Running" status)

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

The setup script handles everything else automatically: configuring the Podman machine, installing the certificate, building Jetstream, and starting it.

**macOS** (Terminal):
```bash
cd ~/Documents/jetstream
./scripts/podman-setup.sh
```

**Windows** (PowerShell):
```powershell
cd $HOME\Documents\jetstream
.\scripts\podman-setup.ps1
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

## Daily Usage

### Starting Jetstream

1. Open **Podman Desktop** (make sure the machine is running)
2. Open Terminal (macOS) or PowerShell (Windows):
   ```bash
   cd ~/Documents/jetstream
   podman compose up
   ```
3. Open **http://localhost:3333/app**

### Stopping Jetstream

Press **Ctrl+C** in the terminal where Jetstream is running.

Or from another terminal:
```bash
podman compose down
```

### Running in the background

```bash
podman compose up -d
```

Stop later with:
```bash
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
podman compose up
```

---

## Troubleshooting

### Common Errors

| Error | Fix |
|---|---|
| `x509: certificate signed by unknown authority` | Zscaler cert not in Podman VM. Re-run the setup script. |
| `unable to get local issuer certificate` | `ZscalerRoot-FullBundle.pem` missing from project folder. Run `git pull` to get it. |
| `getaddrinfo ENOTFOUND github.com` | DNS broken. Run: `podman machine ssh "echo 'nameserver 8.8.8.8' \| sudo tee -a /etc/resolv.conf"` |
| Build silently fails at "rendering chunks..." | Out of memory. Run: `podman machine stop && podman machine set --memory 6144 && podman machine start` |
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
podman compose up
```

> **Warning:** This deletes all local data and starts fresh.

---

## Quick Reference

| Action | Command |
|---|---|
| Start Jetstream | `podman compose up` |
| Start in background | `podman compose up -d` |
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
