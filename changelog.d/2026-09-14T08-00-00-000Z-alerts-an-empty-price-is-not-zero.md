### Fixed

- alerts: **an empty price box no longer creates an alert at $0.** Leave the price empty in the New alert dialog (or type 0 or a negative number) and press Create: the rule was saved as "crossing $0" and the dialog closed as if all was well. A price alert's value must be a positive number now; the dialog shows "Enter a price for the condition." and stays open, the way it already did for a channel missing its second bound.
