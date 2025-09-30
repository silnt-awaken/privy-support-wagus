import { useMemo } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useConnectedStandardWallets } from '@privy-io/react-auth/solana'

export const useAuth = () => {
  const { ready, authenticated, login, logout, user } = usePrivy()
  const { wallets, ready: solanaWalletsReady } = useConnectedStandardWallets()

  // Debug raw wallets structure AND user.linkedAccounts
  console.log('🔍 User linkedAccounts:', user?.linkedAccounts?.map(acc => ({
    type: acc.type,
    address: (acc as any).address,
    chainType: (acc as any).chainType,
    walletClientType: (acc as any).walletClientType,
    verifiedAt: acc.verifiedAt,
  })));

  if (wallets.length > 0) {
    console.log('🔍 Raw wallets array:', {
      walletsLength: wallets.length,
      wallets: wallets.map(w => {
        const wallet = w as any;
        return {
          address: w.address,
          type: wallet.type,
          chainId: wallet.chainId,
          walletClientType: wallet.walletClientType,
          chainType: wallet.chainType,
          walletClient: wallet.walletClient,
          imported: wallet.imported,
          connectorType: wallet.connectorType,
        };
      }),
    });

    // Log each wallet individually
    wallets.forEach((w, i) => {
      console.log(`🔍 Wallet ${i}:`, w);
    });
  }

  // WORKAROUND: useWallets() is not returning Solana wallets, so extract from linkedAccounts
  const solanaWalletsFromLinkedAccounts = (user?.linkedAccounts || [])
    .filter((acc: any) => acc.type === 'wallet' && acc.chainType === 'solana')
    .map((acc: any) => ({
      address: acc.address,
      chainType: 'solana',
      walletClientType: acc.walletClientType,
      // Note: This is a simplified wallet object from linkedAccounts
      // The actual wallet methods will need to be accessed differently
    }));

  // Filter for Solana wallets from useWallets() hook
  const solanaWalletsFromHook = wallets.filter(w => (w as any).type === 'solana')

  // Combine both sources (prefer hook wallets if available)
  const allSolanaWallets = solanaWalletsFromHook.length > 0
    ? solanaWalletsFromHook
    : solanaWalletsFromLinkedAccounts;

  // WORKAROUND: Since useWallets() doesn't return Solana wallets, but we need signing methods,
  // use the first wallet from the hook (even if it's Ethereum type)
  // Privy v2.x should handle cross-chain signing internally
  const firstWalletFromHook = wallets[0] || null
  const solanaWalletAddress = solanaWalletsFromLinkedAccounts[0]?.address

  // Use the wallet from hook (has signing methods) but prefer Solana address from linkedAccounts
  const activeWallet = firstWalletFromHook

  // Debug logging (comment out for production)
  console.log('🔍 Auth State Debug:', {
    privyReady: ready,
    privyAuthenticated: authenticated,
    solanaWalletsReady,
    wagusAuthenticated: ready && authenticated,
    wagusLoading: !ready,
    hasWagusActiveWallet: !!activeWallet,
    activeWalletAddress: activeWallet?.address,
    solanaWalletsFromHookCount: solanaWalletsFromHook?.length || 0,
    solanaWalletsFromLinkedAccountsCount: solanaWalletsFromLinkedAccounts?.length || 0,
    solanaWalletAddress,
    userLinkedAccounts: user?.linkedAccounts?.map(acc => ({ type: acc.type, address: (acc as any).address })),
  })

  const activeWalletClientType = useMemo(() => {
    if (!activeWallet || !user?.linkedAccounts) {
      return undefined
    }

    const matchingLinkedAccount = user.linkedAccounts.find(
      (account) => account.type === 'wallet' && account.address === activeWallet.address,
    )

    return (matchingLinkedAccount as { walletClientType?: string } | undefined)?.walletClientType
  }, [activeWallet, user?.linkedAccounts])

  return {
    isAuthenticated: ready && authenticated,
    isLoading: !ready,
    isConnecting: !ready,
    solanaWalletsReady,
    user,
    activeWallet,
    hasActiveWallet: !!activeWallet,
    activeWalletAddress: activeWallet?.address,
    activeWalletType: activeWalletClientType,
    wallets: allSolanaWallets as any, // Use combined list
    solanaWalletAddress, // Expose the hardcoded address for debugging
    login,
    logout,
  }
}
