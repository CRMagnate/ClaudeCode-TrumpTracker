"""Source adapters (§4). Each adapter exposes fetch_new(store) -> list[RawMention-shaped dicts].

Adapters are selected by env toggles in the pipeline; swapping the Truth Social
archive for a paid source (Apify/ScrapeCreators) means adding a module here that
emits the same RawMention and pointing SOURCE_TRUTHSOCIAL_ADAPTER at it.
"""
