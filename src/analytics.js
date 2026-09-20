/*
 * analytics.js — Vercel Web Analytics integration.
 *
 * Initializes Vercel Analytics for tracking extension usage. Note: This requires
 * the extension to be associated with a Vercel project. Analytics will only work
 * if the project is properly configured in the Vercel dashboard.
 */

import { inject } from '@vercel/analytics';

/**
 * Initialize Vercel Analytics for the extension.
 * This should be called once when the extension loads.
 */
export function initAnalytics() {
  try {
    inject({
      mode: 'production',
      debug: false,
      beforeSend: (event) => {
        // Filter out any sensitive data
        // For a Chrome extension, we'll track custom events rather than page views
        return event;
      }
    });
    console.log('[Ledger] Vercel Analytics initialized');
  } catch (error) {
    console.warn('[Ledger] Failed to initialize Vercel Analytics:', error);
  }
}

/**
 * Track a custom event in Vercel Analytics.
 * @param {string} name - Event name
 * @param {object} properties - Optional event properties
 */
export function trackEvent(name, properties = {}) {
  try {
    if (typeof window !== 'undefined' && window.va) {
      window.va('event', { name, properties });
    }
  } catch (error) {
    console.warn('[Ledger] Failed to track event:', error);
  }
}
