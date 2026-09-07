/**
 * Endpoint de donaciones vía Stripe (Fase A2 — movido tal cual desde index.js).
 */

'use strict';

const express = require('express');
const Stripe = require('stripe');
const { asyncHandler } = require('../errors');
const { publicLimiter } = require('../limiters');

function createStripeRouter(ctx) {
    const router = express.Router();
    const stripe = ctx.config.STRIPE_SECRET_KEY
        ? new Stripe(ctx.config.STRIPE_SECRET_KEY)
        : null;

    /**
     * Create Payment Intent for Stripe donations
     * POST /api/stripe/create-payment-intent
     * Body: { amount: number } // amount in cents
     */
    router.post('/api/stripe/create-payment-intent', publicLimiter, asyncHandler(async (req, res) => {
        if (!stripe) {
            return res.status(503).json({
                error: 'Stripe is not configured on this server'
            });
        }

        const amount = Number(req.body?.amount);

        // Entre $0.50 y $1,000 (evita PaymentIntents absurdos / abuso de la API)
        if (!Number.isFinite(amount) || amount < 50 || amount > 100000) {
            return res.status(400).json({
                error: 'Amount must be between 50 and 100000 cents'
            });
        }

        // Create a PaymentIntent
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(amount),
            currency: 'usd',
            automatic_payment_methods: {
                enabled: true,
            },
            metadata: {
                project: 'carnage-reporter',
                purpose: 'donation'
            }
        });

        res.json({
            clientSecret: paymentIntent.client_secret
        });
    }));

    return router;
}

module.exports = { createStripeRouter };
