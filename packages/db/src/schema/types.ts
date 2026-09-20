// Typed row shapes for every table, derived from the Drizzle column
// definitions with drizzle-orm's InferSelectModel/InferInsertModel so they
// stay in sync automatically. Naming: `<Table>` = select shape (row as read
// back), `New<Table>` = insert shape (defaults/generated columns optional).

import { type userActivity, type searchActivity, type snipingActivity, type riskBudgetEvents } from './activity.js';
import { type adminUsers, type adminActions, type bans, type flags } from './admin.js';
import { type devices, type sessions, type emailVerifications, type passwordResets, type totpRecoveryCodes } from './auth.js';
import { type coupons, type couponRedemptions, type payments, type paymentHistory, type stripeWebhookEvents } from './billing.js';
import { type userSettings, type settingsHistory, type notifications } from './settings.js';
import { type plans, type subscriptions, type licenses } from './subscriptions.js';
import { type auditLogs, type featureToggles, type systemConfig, type ipActivity, type extensionInstalls, type analyticsDaily } from './system.js';
import { type trades, type profits, type savedFilters, type filterStats } from './trading.js';
import { type users } from './users.js';

import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';

export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export type AdminUser = InferSelectModel<typeof adminUsers>;
export type NewAdminUser = InferInsertModel<typeof adminUsers>;
export type AdminAction = InferSelectModel<typeof adminActions>;
export type NewAdminAction = InferInsertModel<typeof adminActions>;
export type Ban = InferSelectModel<typeof bans>;
export type NewBan = InferInsertModel<typeof bans>;
export type Flag = InferSelectModel<typeof flags>;
export type NewFlag = InferInsertModel<typeof flags>;

export type Plan = InferSelectModel<typeof plans>;
export type NewPlan = InferInsertModel<typeof plans>;
export type Subscription = InferSelectModel<typeof subscriptions>;
export type NewSubscription = InferInsertModel<typeof subscriptions>;
export type License = InferSelectModel<typeof licenses>;
export type NewLicense = InferInsertModel<typeof licenses>;

export type Coupon = InferSelectModel<typeof coupons>;
export type NewCoupon = InferInsertModel<typeof coupons>;
export type CouponRedemption = InferSelectModel<typeof couponRedemptions>;
export type NewCouponRedemption = InferInsertModel<typeof couponRedemptions>;
export type Payment = InferSelectModel<typeof payments>;
export type NewPayment = InferInsertModel<typeof payments>;
export type PaymentHistoryEntry = InferSelectModel<typeof paymentHistory>;
export type NewPaymentHistoryEntry = InferInsertModel<typeof paymentHistory>;
export type StripeWebhookEvent = InferSelectModel<typeof stripeWebhookEvents>;
export type NewStripeWebhookEvent = InferInsertModel<typeof stripeWebhookEvents>;

export type Device = InferSelectModel<typeof devices>;
export type NewDevice = InferInsertModel<typeof devices>;
export type Session = InferSelectModel<typeof sessions>;
export type NewSession = InferInsertModel<typeof sessions>;
export type EmailVerification = InferSelectModel<typeof emailVerifications>;
export type NewEmailVerification = InferInsertModel<typeof emailVerifications>;
export type PasswordReset = InferSelectModel<typeof passwordResets>;
export type NewPasswordReset = InferInsertModel<typeof passwordResets>;
export type TotpRecoveryCode = InferSelectModel<typeof totpRecoveryCodes>;
export type NewTotpRecoveryCode = InferInsertModel<typeof totpRecoveryCodes>;

export type UserActivity = InferSelectModel<typeof userActivity>;
export type NewUserActivity = InferInsertModel<typeof userActivity>;
export type SearchActivity = InferSelectModel<typeof searchActivity>;
export type NewSearchActivity = InferInsertModel<typeof searchActivity>;
export type SnipingActivity = InferSelectModel<typeof snipingActivity>;
export type NewSnipingActivity = InferInsertModel<typeof snipingActivity>;
export type RiskBudgetEvent = InferSelectModel<typeof riskBudgetEvents>;
export type NewRiskBudgetEvent = InferInsertModel<typeof riskBudgetEvents>;

export type Trade = InferSelectModel<typeof trades>;
export type NewTrade = InferInsertModel<typeof trades>;
export type Profit = InferSelectModel<typeof profits>;
export type NewProfit = InferInsertModel<typeof profits>;
export type SavedFilter = InferSelectModel<typeof savedFilters>;
export type NewSavedFilter = InferInsertModel<typeof savedFilters>;
export type FilterStat = InferSelectModel<typeof filterStats>;
export type NewFilterStat = InferInsertModel<typeof filterStats>;

export type UserSettings = InferSelectModel<typeof userSettings>;
export type NewUserSettings = InferInsertModel<typeof userSettings>;
export type SettingsHistoryEntry = InferSelectModel<typeof settingsHistory>;
export type NewSettingsHistoryEntry = InferInsertModel<typeof settingsHistory>;
export type Notification = InferSelectModel<typeof notifications>;
export type NewNotification = InferInsertModel<typeof notifications>;

export type AuditLog = InferSelectModel<typeof auditLogs>;
export type NewAuditLog = InferInsertModel<typeof auditLogs>;
export type FeatureToggle = InferSelectModel<typeof featureToggles>;
export type NewFeatureToggle = InferInsertModel<typeof featureToggles>;
export type SystemConfig = InferSelectModel<typeof systemConfig>;
export type NewSystemConfig = InferInsertModel<typeof systemConfig>;
export type IpActivity = InferSelectModel<typeof ipActivity>;
export type NewIpActivity = InferInsertModel<typeof ipActivity>;
export type ExtensionInstall = InferSelectModel<typeof extensionInstalls>;
export type NewExtensionInstall = InferInsertModel<typeof extensionInstalls>;
export type AnalyticsDailyRow = InferSelectModel<typeof analyticsDaily>;
export type NewAnalyticsDailyRow = InferInsertModel<typeof analyticsDaily>;
