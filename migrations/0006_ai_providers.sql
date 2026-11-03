-- AI usage is now tracked per provider. Prices are only known for some models; for the rest only tokens count.
ALTER TABLE ai_usage ADD COLUMN provider TEXT NOT NULL DEFAULT 'anthropic';
ALTER TABLE ai_usage ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 1;
