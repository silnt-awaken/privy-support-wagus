# Privy Embedded Wallet Cross-Platform Issue Reproduction

## Problem Description

Embedded Solana wallet created on Flutter mobile app (using `privy_flutter@0.4.0`) cannot sign transactions on React web app (using `@privy-io/react-auth@2.25.0`), despite user being authenticated.

### Error
```text
User must be authenticated to use their embedded wallet.
```
### Observed Behavior
- ✅ User IS authenticated (`privyAuthenticated: true`)
- ✅ Wallet appears in `user.linkedAccounts`
- ✅ Wallet found via `useConnectedStandardWallets()`
- ❌ Calling `signAndSendTransaction()` fails with authentication error

### Configuration
- **Same Privy App ID** across both platforms
- **Different Client IDs** (mobile vs web, as required by Privy)
- **Same RPC endpoint** (Helius mainnet)
- **Same user** (email authentication)
- **Same wallet address**

## Setup Instructions

1. **Clone and install dependencies:**
   ```bash
   git clone <repo-url>
   cd privy-embedded-wallet-repro
   npm install --legacy-peer-deps
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and fill in **YOUR OWN TEST VALUES**:
   ```bash
   cp .env.example .env
   ```

   **IMPORTANT:** Use your own Privy test app for reproduction:
   - Create a test Privy app at https://dashboard.privy.io
   - Create both a mobile AND web client under the same App ID
   - Enable Solana embedded wallets in your app settings
   - Use your own RPC endpoint and Firebase project

3. **Run the dev server:**
   ```bash
   npm run dev
   ```

## Reproduction Steps

### Mobile Setup (Required First)
1. Create an embedded wallet on mobile using `privy_flutter@0.4.0` with your **mobile Client ID**
2. Wallet should be successfully created and able to sign transactions
3. Note the wallet address that was created

### Web Reproduction (This fails)
1. Navigate to: `http://localhost:5173/?action=fund_pool&worldId=test&tokenMint=<TOKEN_MINT>&amount=1.0&userAddress=<WALLET_ADDRESS_FROM_MOBILE>&operationId=test123&poolAddress=<DESTINATION_ADDRESS>`
2. Click "Sign In with Privy" and authenticate with **same email used on mobile**
3. Wallet appears in connected wallets list (visible in diagnostics)
4. Click "Authorize Funding"
5. ❌ Error occurs: "User must be authenticated to use their embedded wallet"

## Code Locations

### Where the error occurs
**File:** `src/pages/PoolBridge.tsx`
**Lines:** 1282-1289 (funding) and 1763-1770 (withdrawal)

```typescript
// This call fails despite user being authenticated
const result = await (standardWallet as any).signAndSendTransaction({
  chain: chain,
  transaction: serializedTransaction,
});
```

### Privy Configuration
**File:** `src/App.tsx`

```typescript
<PrivyProvider
  appId={import.meta.env.VITE_PRIVY_APP_ID}
  clientId={import.meta.env.VITE_PRIVY_CLIENT_ID}
  config={{
    embeddedWallets: {
      createOnLogin: "all-users",
    },
    appearance: {
      theme: "dark",
      accentColor: "#ea580c",
      walletChainType: "solana-only",
    },
  }}
>
```

## Implementation Details

- Using Privy v2.25.0 (latest)
- Signing directly in `sendInstructions` function (no helper abstraction)
- Transaction serialized as `Uint8Array` as required by Privy API
- Wallet obtained from `useConnectedStandardWallets()` hook
- Chain ID correctly inferred from RPC URL

## Expected Behavior

According to Privy documentation, embedded wallets should work across different clients within the same App ID. The wallet keys should be automatically reconstituted when the user authenticates on a new device/client.

## Actual Behavior

The wallet is visible and accessible, but attempting to sign transactions fails with an authentication error, suggesting the wallet keys have not been properly provisioned/reconstituted on the web client.

## Changes Made Per Support Request

1. ✅ Updated from Privy 2.24.0 to 2.25.0
2. ✅ Removed helper function abstraction
3. ✅ Signing directly in sendInstructions function
4. ❌ Same error persists

## Questions

1. Does cross-platform embedded wallet access require additional configuration?
2. Do different SDK versions (React 2.25.0 vs Flutter 0.4.0) affect wallet key sharing?
3. Is there a provisioning step missing for wallets created on mobile to work on web?
4. Should we be using password recovery or cloud recovery for cross-client access?

## Environment

- **Web Framework:** React 18 + Vite 6
- **Privy SDK:** @privy-io/react-auth@2.25.0
- **Solana SDK:** @solana/web3.js@1.98.4
- **Backend:** Firebase Firestore (for operation tracking)
- **Issue Status:** Persists after implementing all recommended changes
