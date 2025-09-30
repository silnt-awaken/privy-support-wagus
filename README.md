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
   npm install
   ```

2. **Configure environment variables:**
   Copy `.env.example` to `.env` and fill in your values:
   ```bash
   cp .env.example .env
   ```

   Required variables:
   - `VITE_PRIVY_APP_ID` - Your Privy App ID
   - `VITE_PRIVY_CLIENT_ID` - Your Privy **Web** Client ID
   - `VITE_HELIUS_RPC` - Your Helius RPC endpoint
   - Firebase configuration (for operation tracking)

3. **Run the dev server:**
   ```bash
   npm run dev
   ```

## Reproduction Steps

### Mobile Setup (Flutter)
1. User creates embedded wallet on mobile app using `privy_flutter@0.4.0`
2. Wallet is successfully created and can sign transactions
3. Wallet address: `5sBigeCbU7smExspEE1zQ84KWA1Bj8eJaEbaKh9kaJsc` (example)

### Web Reproduction
1. Navigate to: `http://localhost:5173/?action=fund_pool&worldId=test&tokenMint=<TOKEN_MINT>&amount=1.0&userAddress=<WALLET_ADDRESS>&operationId=<OP_ID>&poolAddress=<POOL_ADDRESS>`
2. Click "Login with Privy" and authenticate with same email used on mobile
3. Wallet appears in connected wallets list
4. Click "Execute Transaction"
5. ❌ Error occurs: "User must be authenticated to use their embedded wallet"

## Code Locations

### Where the error occurs
**File:** `src/pages/PoolBridge.tsx`
**Line:** ~209

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

## Questions

1. Does cross-platform embedded wallet access require additional configuration?
2. Do different SDK versions (React 2.25.0 vs Flutter 0.4.0) affect wallet key sharing?
3. Is there a provisioning step missing for wallets created on mobile to work on web?
4. Should we be using password recovery or cloud recovery for cross-client access?

## Contact

- Issue occurs in production environment
- Same behavior observed in development
- 20+ hours of debugging with no resolution
