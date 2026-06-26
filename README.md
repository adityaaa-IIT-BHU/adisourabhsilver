# Silver Care — Premium Nursing Agency

A web application for **Silver Care**, a premium nursing agency, built on **Firebase** (Hosting + Firestore + Cloud Functions). It combines a public marketing/booking website with an AI-assisted enquiry system and telephony integration for handling client requests.

## Features

- **Public website** — landing page, pricing, contact, and policy pages (privacy, refund, terms).
- **AI chat assistant** — an OpenAI-powered webhook that answers enquiries and **remembers conversation history** by persisting it to Firestore.
- **Telephony integration** — processes call data and recordings via **Exotel** for follow-up.
- **Admin tools** — staff directory and WhatsApp request handling.

## Tech Stack

- **Frontend:** static HTML/CSS served via Firebase Hosting (`public/`)
- **Backend:** Firebase Cloud Functions (Node.js) — `openai`, `axios`, `firebase-admin`
- **Database:** Cloud Firestore
- **Integrations:** OpenAI, Exotel

## Project Structure

```
public/              Static site served by Firebase Hosting
  index.html         Landing page + admin UI
  pricing.html       Pricing
  contact.html       Contact
  privacy.html       Privacy policy
  refund.html        Refund policy
  terms.html         Terms of service
  404.html           Not-found page
functions/           Firebase Cloud Functions
  index.js           webhook (AI chat) + exotelProcess (telephony)
firestore.rules      Firestore security rules
storage.rules        Storage security rules
firebase.json        Firebase project config
```

## Cloud Functions

| Function | Type | Purpose |
|----------|------|---------|
| `webhook` | HTTPS | OpenAI-backed chat assistant with Firestore-persisted memory |
| `exotelProcess` | HTTPS | Handles Exotel call data and recording URLs |

## Setup

```bash
# Install function dependencies
cd functions && npm install

# Run locally with the Firebase emulators
firebase emulators:start

# Deploy hosting + functions
firebase deploy
```

> **Configuration:** backend secrets (OpenAI key, Exotel credentials) are read from the environment / Firebase config at runtime and are **not** committed. Set them before deploying. The Firebase web API key in `public/index.html` is a client-side identifier (safe to be public); access is controlled by the Firestore/Storage security rules.
