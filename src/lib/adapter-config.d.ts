// This file extends the AdapterConfig type from "@types/iobroker"

// Augment the globally declared type ioBroker.AdapterConfig
declare global {
    namespace ioBroker {
        interface AdapterConfig {
            host: string;
            port: number;
            luxPort: number;
            password: string;
            refreshInterval: number;
            useLuxProxy?: boolean; // obsolete
        }
    }
}

// this is required so the above AdapterConfig is found by TypeScript / type checking
export {};
