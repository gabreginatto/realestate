# Mobile Access Setup Guide

## Overview
Access the Human-in-the-Loop matcher from your phone on the same WiFi network.

## Quick Setup

### 1. Find Your PC's Local IP Address

Run this command on your PC:
```bash
# Mac/Linux:
ifconfig | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | head -1

# Windows (PowerShell):
ipconfig | findstr "IPv4"
```

You should see something like: `192.168.1.100` (your local network IP)

### 2. Start the Server on All Network Interfaces

Instead of binding to `localhost` only, we need to bind to `0.0.0.0` (all interfaces):

**Option A: Set Environment Variable**
```bash
export HOST=0.0.0.0
node scripts/human-loop/matching-server.js
```

**Option B: Modify the server file temporarily**
Edit `scripts/human-loop/matching-server.js` line 575:
```javascript
// Change from:
app.listen(PORT, () => {

// To:
app.listen(PORT, '0.0.0.0', () => {
```

### 3. Access from Your Phone

1. Connect your phone to the **same WiFi network** as your PC
2. Open a browser on your phone (Safari, Chrome, etc.)
3. Navigate to: `http://YOUR_LOCAL_IP:3000/matcher.html`
   - Example: `http://192.168.1.100:3000/matcher.html`

### 4. Check Firewall Settings

If you can't connect, you may need to allow port 3000:

**Mac:**
```bash
# Check if firewall is on
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# If on, allow Node.js:
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/local/bin/node
```

**Windows:**
```powershell
# Allow port 3000 through Windows Firewall
New-NetFirewallRule -DisplayName "Node Matcher Server" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

**Linux:**
```bash
# Using ufw
sudo ufw allow 3000/tcp

# Using iptables
sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

## Mobile-Friendly Features

The interface is already fully responsive with:
- ✅ Full-width layout on mobile (under 768px)
- ✅ Stacked cards for easy scrolling
- ✅ Touch-friendly buttons
- ✅ Pinch-to-zoom on images
- ✅ Responsive header and navigation

## Tips for Mobile Usage

1. **Portrait mode works best** - cards stack vertically
2. **Tap images** to view in lightbox with zoom
3. **Swipe gestures** aren't implemented yet (future enhancement)
4. **Keep screen awake** - use your phone's settings to prevent auto-lock during long review sessions

## Security Considerations

⚠️ **Important**: This setup only works on your local network. The server is NOT exposed to the internet.

- ✅ Safe: Same WiFi network at home
- ✅ Safe: Private network
- ❌ Not accessible from outside your home network
- ❌ Not accessible over cellular data (unless you set up VPN)

If you want to access from anywhere (like from work), you would need:
- VPN connection to your home network, OR
- Port forwarding + dynamic DNS (less secure), OR
- Deploy to a cloud server with HTTPS

## Troubleshooting

### Can't connect from phone?

1. **Verify same network**: Both PC and phone on same WiFi
2. **Check IP address**: Make sure you're using the correct local IP
3. **Test from PC first**: Try `http://YOUR_LOCAL_IP:3000/matcher.html` on your PC browser
4. **Check firewall**: See firewall settings above
5. **Try different IP format**:
   - `http://192.168.1.100:3000` (with http://)
   - Not `https://` (we don't have SSL cert)

### Server keeps saying "localhost"?

The server will still print `http://localhost:3000` in the console, but it's actually listening on all interfaces if you used `0.0.0.0`. Just use your local IP instead.

### Images not loading?

Make sure the mosaics directory path is accessible:
```bash
ls -la data/mosaics/viva/
ls -la data/mosaics/coelho/
```

## Advanced: Permanent Configuration

If you want this to be the default behavior, we can modify the server to always bind to `0.0.0.0`:

```javascript
// In scripts/human-loop/matching-server.js
const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.MATCHING_PORT || 3000;

// Then update the listen call:
app.listen(PORT, HOST, () => {
  const networkIP = getLocalIP(); // We can add this helper
  console.log(`\n✅ Server running on:`);
  console.log(`   Local:   http://localhost:${PORT}`);
  console.log(`   Network: http://${networkIP}:${PORT}`);
  console.log(`\nOpen http://localhost:${PORT}/matcher.html to start matching`);
  console.log(`Or use network address for mobile access\n`);
});
```

Would you like me to implement this permanent solution?
