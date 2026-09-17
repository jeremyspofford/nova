## 00:16

User: what's the latest on openai

Assistant: Three items from the last day. They shipped a smaller reasoning tier that undercuts their own mid model on price, an enterprise agreement with a large European bank went public, and there is another round of the safety-team departure story doing the rounds. Sources: theverge.com, reuters.com and techcrunch.com. None of it changes anything you are building this week.

## 00:19

User: and you cant figure out how to bypass that? What about docs, or an rss feed, or anything else that would let you read the actual article instead of the summary of it

Assistant: Not by myself, no. The fetch tool gets the page the site chooses to hand an unauthenticated client, and for that publisher the page it hands back is a paywall stub with the first two paragraphs. An RSS feed carries the same two paragraphs, and the developer docs are a different site entirely. What would work is a reader account whose cookie I could use, or a copy you paste in yourself. I would rather say that plainly than summarise a summary and let it read as if I had the article.

## 02:41

User: what's the latest on openai

Assistant: Since the last time you asked, two hours ago, one thing actually moved: the pricing page now lists the smaller reasoning tier at a third of the mid model, per million tokens, with a longer context window than the announcement said. The bank deal is the same story from three outlets, reuters.com first and the other two following it, so treat it as one source rather than three. The departures thread is comment, not news, and I would not spend attention on it. There is also a developer-day date, the second week of November, which is the only item with a date you could put in a calendar. The pricing page is on openai.com and the two write-ups I read are on theverge.com and arstechnica.com, so if you want the primary source rather than my paraphrase it is the first of those three. I have not read the pricing page itself, only the summary card the search returned, so take the numbers as reported rather than confirmed.

## 03:11

User: what about the pixel?

Assistant: Nothing new in the last day. The most recent thing is still the feature-drop rumour with no date attached to it, from a single site, which I would leave alone until somebody with a name puts it in writing.

## 12:07

User: what about hte pixel?

Assistant: Still nothing dated. There is a second site carrying the same feature-drop rumour now, which is not independent confirmation, it is the same paragraph with a different headline on it. If you want I can keep an eye on it and tell you when something has an actual date on it rather than a maybe.

## 13:04

User: No, that's good. Thanks

Assistant: Any time. I will leave the phone story alone until it has a date.

## 13:13

User: I have 24gb of vram with 64gb of system ram, non-unified.. You should know that about the machine you run on. What can I actually run locally on that?

Assistant: Noted, and it is a useful thing for me to hold rather than ask again: this box has 24GB of VRAM on the card and 64GB of system RAM beside it, and the two pools are separate, so nothing spills between them for free. What that buys you, in practice: a 27B-class model at 4-bit quantisation sits at roughly 16 to 18GB of weights, which leaves enough headroom on the card for a 32k context window and the KV cache that goes with it, and it stays resident between turns instead of being loaded and evicted. A 70B at the same quantisation does not fit on the card at all; you can run it with layers on the CPU, but the moment weights live in system RAM the turn goes from a couple of seconds to most of a minute, because every token pays the trip across the bus. Two 7B models resident at once is comfortable and is worth considering if you want one model answering chat while a second one does the background work without evicting the first. The thing that will bite you before the weights do is the context window: cache for a long conversation grows fast, and it grows on the card, so a 32k window on a 27B model is a much better trade than a 128k window on a 13B. If you want I can put the numbers for a specific model side by side before you pull it. Two more things that follow from those numbers rather than from a benchmark. The first is that quantisation is not free below 4-bit: a 3-bit build of the same 27B model fits with room to spare and is noticeably worse at exactly the thing you use it for, which is holding a long argument straight, so the headroom you would buy is headroom you would regret. The second is that the system RAM is not wasted just because the weights are not in it; it is where the operating system caches the model file, so a model you have run once loads in seconds the next time rather than being read off the disk again. With 64GB you can keep two or three large model files warm in that cache at once, which is why switching between models feels fast after the first time and slow before it.
