# Mira accounts setup

Mira accounts run on the T3 Connect relay: Clerk owns sign-in, the relay stores plans,
subscriptions, and monthly usage, and proxies model requests to DeepSeek with the key the admin
saves. Finish [T3 Connect setup](./connect-setup.md) first; this page covers what Mira adds.

## Relay secrets

Set these in `infra/relay/.env` before `vpr deploy` (see `infra/relay/.env.example`):

- `SAAS_ADMIN_EMAILS`: who can open `/admin`. Matched against the Clerk account's verified primary
  email.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: from the Stripe dashboard. Without them,
  Upgrade fails with "Payments are not set up yet".

The relay encrypts the DeepSeek key with a random secret Alchemy generates per stage
(`SaasSettingsSecret`). Destroying and recreating the stage loses it; save the key again in
`/admin` afterwards.

## Clerk

Add the relay origin (`https://relay.<zone>`) to the Clerk instance's allowed origins so the admin
page can load Clerk and request `t3-relay` tokens.

## Stripe

1. Create a product per paid plan with a recurring monthly price. Copy each price id
   (`price_...`).
2. Add a webhook endpoint at `https://relay.<zone>/v1/billing/stripe-webhook` for
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, and `customer.subscription.deleted`. Its signing secret is
   `STRIPE_WEBHOOK_SECRET`.
3. Turn on the Customer Portal so users can cancel and change cards.

A live subscription (`active`, `trialing`, `past_due`) puts the account on the plan whose Stripe
price it pays. Any other state returns it to the default plan.

## Admin page

Open `https://relay.<zone>/admin` and sign in with an admin account.

- **Model**: save the DeepSeek API key and model id. Users get "The model is not configured yet"
  until a key is saved.
- **Plans**: Free and Pro exist after the first deploy. Set each plan's monthly tokens, and the
  Stripe price id on paid plans. The default plan is what new accounts get. The app's Upgrade
  button buys the plan with id `pro`.
- **Users**: shows this month's tokens per account and lets you move an account to another plan.
  A Stripe webhook later overrides a manual change for accounts with a subscription.

Usage counts input plus output tokens per UTC calendar month. A request that starts under the
limit finishes even if it crosses it.
