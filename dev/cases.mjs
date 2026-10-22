// Regression cases for lineToRomaji. Sentences are written for these tests, not taken from songs.
export default [
  // particles
  ["私は猫です", "watashi wa neko desu"],
  ["ここでは話せない", "koko de wa hanasenai"],
  ["君には見えない", "kimi ni wa mienai"],
  ["こんにちは", "konnichiwa"],
  ["こんばんは", "konbanwa"],
  ["空へ飛ぶ", "sora e tobu"],
  ["夢を見る", "yume o miru"],
  ["花は咲く", "hana wa saku"],
  // furigana / reading in brackets, common in lyrics
  ["運命(さだめ)を信じて", "sadame o shinjite"],
  ["地球（ほし）の歌", "hoshi no uta"],
  ["本気(マジ)で行く", "maji de iku"],
  // plural ら
  ["僕等は行く", "bokura wa iku"],
  // long vowels and small kana
  ["すごーい", "sugooi"],
  ["ねぇ、聞いて", "nee, kiite"],
  ["ちょっと待って", "chotto matte"],
  ["あっ", "a"],
  ["パーティーへ行こう", "paatii e ikou"],
  ["ヴァイオリン", "vaiorin"],
  // ん before a vowel or y
  ["原因は何", "gen'in wa nani"],
  ["今夜は", "kon'ya wa"],
  // iteration marks
  ["人々の声", "hitobito no koe"],
  ["時々思う", "tokidoki omou"],
  ["星々の光", "hoshiboshi no hikari"],
  ["花々が咲く", "hanabana ga saku"],
  ["堂々と歩く", "doudou to aruku"],
  // width and symbols
  ["ｶﾀｶﾅで書く", "katakana de kaku"],
  ["１２３回目", "123 kaime"],
  ["ＡＢＣの歌", "ABC no uta"],
  ["本当？！", "hontou?!"],
  ["待って…", "matte..."],
  ["【夢】と《愛》", "\"yume\" to \"ai\""],
  ["♪ララ", "♪ rara"],
  // mixed English
  ["I love you 君が好き", "I love you kimi ga suki"],
  ["God's 神のまにまに [SUB]", "God's kami no manimani [SUB]"],
  ["I'm 天使(てんし)だよ", "I'm tenshi da yo"],
  ["Hey! 行こうぜ", "Hey! ikou ze"],
  // verbs, contractions
  ["何してるの", "nani shiteru no"],
  ["じゃない", "ja nai"],
  ["忘れちゃった", "wasurechatta"],
  // counters the dictionary misreads, iteration marks, readings after Latin words
  ["二人の時間", "futari no jikan"],
  ["一人一人", "hitorihitori"],
  ["たゞいま", "tadaima"],
  ["あゝ", "aa"],
  ["Love(ラブ)ソング", "Love songu"],
  ["それな(笑)", "sore na (warai)"],
  ["愛(あい)してる", "aishiteru"],
  // katakana the dictionary splits into pieces
  ["ミライへ行く", "mirai e iku"],
  ["ココロとカラダ", "kokoro to karada"],
  // middle dot, inline kana after kanji
  ["林檎・蜜柑", "ringo · mikan"],
  ["ジャン・ポール", "jan · pooru"],
  ["蔑さげすむ目", "sagesumu me"],
  // kanji missing from the dictionary: on'yomi inside a compound
  ["遮断桿が下りる", "shadankan ga oriru"],
  ["僕等は", "bokura wa"],
];
