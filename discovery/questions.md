# Questions for the panel (non-blocking; defaults assumed)

1. Which jurisdiction would you add third (EU / Nasdaq Copenhagen, Australia ASX)? Decides which policy primitives (e.g. national storage mechanisms, language rules) we should generalise first.
2. Do customers want us to integrate directly with each newswire, or sit in front of a vendor they already pay? Decides gateway ownership, cost and SLAs.
3. Who signs off disclosure today (company secretary, legal, disclosure committee)? We model this as approval requirements per category; the real org chart may differ per tenant.
4. Is scheduled release at an exact time (07:00 UK results) a launch requirement? We cut it; it adds a time-critical path.
5. Should the AI pre-check ever block a release, or stay advisory? We keep it advisory because liability for the disclosure stays with the issuer.
6. Expected volumes per tenant and peak clustering? We assumed low steady rate with earnings-season bursts.
