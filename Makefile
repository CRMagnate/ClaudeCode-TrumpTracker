.PHONY: test smoke poll backfill test-alert

test:
	python -m pytest tests/ -v

# Live classification sanity check against real providers — needs keys in .env.
# Never runs in CI (§11).
smoke:
	python -m tracker.smoke

poll:
	python -m tracker.pipeline poll

backfill:
	python -m tracker.pipeline poll --backfill-days 14

test-alert:
	python -m tracker.pipeline test-alert
