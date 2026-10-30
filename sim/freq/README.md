# English frequency list

`en_50k.txt` is the 50,000 most frequent English words in the
OpenSubtitles 2018 corpus, one `word count` pair per line, most
frequent first. Line number is the word's frequency rank.

Origin: Hermit Dave's FrequencyWords project,
https://github.com/hermitdave/FrequencyWords
(`content/2018/en/en_50k.txt`), generated from the tokenised
OpenSubtitles 2018 release published by OPUS,
http://opus.nlpl.eu/OpenSubtitles2018.php.

License: the list is published under Creative Commons
Attribution-ShareAlike 4.0 (CC BY-SA 4.0); the generator code is MIT.
The file is unchanged from the upstream copy.

A subtitle corpus was chosen over a web or book corpus because the
words it ranks are the words people say on screen, which is what
`sim/vocab.mjs` measures a character's lines against.
