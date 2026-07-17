# Security policy

Do not report vulnerabilities in public issues. Report them privately to the repository owner with a minimal reproduction and impact description. Never include API keys, access tokens, refresh tokens, or customer data.

This SDK never persists credentials. Applications are responsible for secure secret storage and for implementing the atomic `refresh_and_persist` transaction required by rotating OAuth tokens.
