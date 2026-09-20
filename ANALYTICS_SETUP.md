# Vercel Web Analytics Setup

This document explains the Vercel Web Analytics integration in the Ledger extension.

## Installation Status

✅ **Installed**: `@vercel/analytics` package has been added to the project.

## Integration Points

### 1. Analytics Module (`src/analytics.js`)
A new module has been created to handle all Vercel Analytics functionality:
- `initAnalytics()` - Initializes Vercel Analytics
- `trackEvent(name, properties)` - Tracks custom events

### 2. Content Script (`src/content.js`)
Analytics is initialized when the content script loads and tracks:
- **market_search** - Fired when a user performs a market search
- **auctions_recorded** - Fired when auction data is successfully recorded

### 3. Background Service Worker (`src/background.js`)
Analytics is initialized when the service worker starts.

## Important Limitations

⚠️ **Critical**: Vercel Web Analytics requires a Vercel deployment to function properly. This Chrome extension will need additional configuration:

### Requirements for Analytics to Work:

1. **Vercel Project Setup**
   - Create a Vercel account at https://vercel.com
   - Create a new project in the Vercel dashboard
   - Enable Web Analytics in the project settings

2. **Deployment Context**
   - The extension needs to be associated with a Vercel project
   - Analytics data is sent to `/_vercel/insights/*` endpoints
   - These endpoints only exist on Vercel-hosted projects

3. **Alternative Approach**
   If you want analytics for this Chrome extension specifically:
   - Consider creating a companion web dashboard hosted on Vercel
   - Use Google Analytics 4 with Measurement Protocol (designed for extensions)
   - Use privacy-focused alternatives like Plausible or Mixpanel

## Configuration

The analytics are initialized with the following settings:

```javascript
inject({
  mode: 'production',
  debug: false,  // Set to true for console logging
  beforeSend: (event) => {
    // Filter events here if needed
    return event;
  }
});
```

## Events Being Tracked

1. **market_search**
   - Triggered when a market search is performed
   - Properties: `{ auction_count: number }`

2. **auctions_recorded**
   - Triggered when auctions are successfully saved
   - Properties: `{ count: number }`

## Testing

To test the analytics integration:

1. Set `debug: true` in `src/analytics.js`
2. Load the unpacked extension in Chrome
3. Open the browser console
4. Perform market searches in the EA FC web app
5. Look for analytics initialization and event tracking messages

## Enabling Debug Mode

Edit `src/analytics.js` and change:
```javascript
inject({
  mode: 'production',
  debug: true,  // Enable debug logging
  // ...
});
```

## Next Steps

To make analytics fully functional:

1. Deploy a companion web app to Vercel (even a simple landing page)
2. Enable Web Analytics in the Vercel dashboard for that project
3. Ensure the extension can reach the Vercel analytics endpoints
4. Consider Content Security Policy (CSP) implications for the extension

## Alternative: Removing Analytics

If you decide not to use Vercel Analytics, you can remove it:

```bash
npm uninstall @vercel/analytics
```

Then remove these files/changes:
- Delete `src/analytics.js`
- Remove import and calls from `src/content.js`
- Remove import and calls from `src/background.js`
