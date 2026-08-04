fix(tests): the greenpath release gate was red on two behaviour changes, not defects

The gate walks a Free account to Pro, and it still encoded the pre-#3039 journey: a bare
`goto('/stock-trader.html')` now redirects a Free user to Watch, so the upgrade CTA it
asserts never rendered. It also called the staff role endpoint without a `reason`, which
#3100 made mandatory for granting a paid tier by hand. Both are now correct, taking the
run from 3 passed / 1 failed / 5 not-run to 8 passed.
