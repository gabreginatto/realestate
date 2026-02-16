# Property Matcher Mobile App

React Native mobile app for human-in-the-loop property matching. Built with Expo.

## Prerequisites

- Node.js 18+
- npm or yarn
- iOS Simulator (Mac) or Android Studio (for Android emulator)
- Expo Go app on your physical device (optional)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the development server:
```bash
npm start
```

3. Run on your device:
   - **iOS Simulator**: Press `i` in the terminal
   - **Android Emulator**: Press `a` in the terminal
   - **Physical Device**: Scan the QR code with Expo Go

## Configuration

### API Server

The app connects to the matching server at `http://localhost:3000` by default.

To change the API URL, update `API_BASE_URL` in:
- `lib/api.ts`

For mobile device testing, you'll need to use your computer's network IP address instead of `localhost`.

### Starting the Backend Server

From the main project directory:
```bash
node scripts/human-loop/matching-server.js
```

The server will display its network IP address on startup.

## Project Structure

```
matcher-mobile/
├── app/                    # Expo Router screens
│   ├── _layout.tsx        # Root layout
│   └── index.tsx          # Main matcher screen
├── components/            # Reusable UI components
│   ├── Header.tsx         # App header with stats
│   ├── PropertyCard.tsx   # Property display
│   ├── CandidateCard.tsx  # Candidate with match button
│   ├── CandidateList.tsx  # Virtualized candidate list
│   └── ...
├── hooks/                 # Custom React hooks
├── lib/                   # Utilities
│   ├── api.ts            # API client
│   ├── formatters.ts     # Price/delta formatting
│   └── haptics.ts        # Haptic feedback
├── stores/               # State management
│   └── matcherStore.ts   # Zustand store
└── types/                # TypeScript definitions
    └── index.ts
```

## Features

- Property image comparison
- AI confidence scores
- Price/area delta indicators
- Match confirmation with haptic feedback
- Skip functionality
- Undo last decision
- Progress tracking
- Dark/light mode support (automatic)

## Tech Stack

- **Expo SDK 54** - React Native framework
- **Expo Router** - File-based routing
- **Zustand** - State management
- **FlashList** - Performant lists
- **expo-image** - Optimized image loading
- **react-native-reanimated** - Animations

## Development

### Type Checking

```bash
npx tsc --noEmit
```

### Building for Production

```bash
npx expo build:ios
npx expo build:android
```

Or use EAS Build:
```bash
npx eas build --platform all
```
