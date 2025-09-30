import React from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import { PrivyProvider } from "@privy-io/react-auth";
import PoolBridge from "./pages/PoolBridge";

function App() {
  return (
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
      <Router>
        <Routes>
          <Route path="/" element={<PoolBridge />} />
        </Routes>
      </Router>
    </PrivyProvider>
  );
}

export default App;