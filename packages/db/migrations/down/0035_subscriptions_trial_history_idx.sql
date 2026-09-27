-- Down for 0035_subscriptions_trial_history_idx.sql (down files always run
-- in a transaction, so this is a plain DROP INDEX).
DROP INDEX IF EXISTS subscriptions_user_id_plan_id_idx;
