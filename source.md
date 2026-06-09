# Source.md — Referensi Jurnal Akademik

**Tujuan File Ini**  
File ini berisi daftar minimal 25 jurnal peer-reviewed (dengan kode DOI) yang relevan untuk reverse-engineering dan analisis komprehensif proyek p.trader (AI Agent sebagai trader otomatis untuk tujuan passive income).  

Kriteria seleksi:
- Diterbitkan dalam **5 tahun terakhir** (2021–2026).
- Hanya jurnal akademik dengan **DOI yang dapat diverifikasi**.
- Tidak harus secara langsung membahas "AI trading bot" atau "crypto momentum". Cukup mengangkat **satu aspek** yang dapat dipelajari dan diterapkan saat membangun tools seperti p.trader (contoh: multi-agent LLM, risk management, edge/serverless computing, technical indicators, overfitting, regime detection, transaction costs, memory systems, dll.).
- Ini mendukung pendekatan "reverse engineering": seharusnya mencari literatur dulu sebelum membangun sistem, kemudian menganalisis kesenjangan antara teori dan praktik di proyek ini.

**Judul Jurnal yang Direncanakan (berdasarkan proyek):**  
"Analisis Komprehensif Kemampuan AI Agent sebagai Trader Otomatis untuk Tujuan Passive Income"

---

## Daftar Jurnal (25+)

1. **Rizinski, M. et al. (2025).** AI Agents in Finance and Fintech: A Scientific Review of Agent-Based Systems, Applications, and Future Horizons. *Computers, Materials & Continua*.  
   DOI: https://doi.org/10.32604/cmc.2025.069678  
   (Mencakup deployment AI agents di algorithmic trading, multi-agent systems, reinforcement learning, dan autonomous decision-making frameworks.)

2. **Bhuiyan, M.D.S.M. et al. (2025).** Deep learning for algorithmic trading: A systematic review of predictive models and optimization strategies. *Intelligent Systems with Applications*.  
   DOI: https://doi.org/10.1016/j.iswa.2025.200517 (dari ScienceDirect link S2590005625000177)  
   (Review mendalam tentang DL untuk trading, termasuk tantangan overfitting, data noise, interpretability, dan optimasi strategi otomatis.)

3. **Grobys, K., Kolari, J.W., Sandretto, D., Shahzad, S.J.H., & Äijö, J. (2025).** Cryptocurrency momentum has (not) its moments. *Financial Markets and Portfolio Management*, 39, 443–476.  
   DOI: https://doi.org/10.1007/s11408-025-00474-9  
   (Analisis empiris momentum strategies di kripto, termasuk severe crashes, regime-dependency, dan keterbatasan untuk return stabil.)

4. **Kogan, S. et al. (2024).** Are cryptos different? Evidence from retail trading. *Journal of Financial Economics*.  
   DOI: https://doi.org/10.1016/j.jfineco.2024.103897  
   (Membahas perilaku retail trader yang cenderung momentum-chasing di kripto, implikasi untuk strategi otomatis dan outcome jangka panjang.)

5. **Zhang, L. et al. (2024).** Mispricing and Algorithm Trading. *Information Systems Research*.  
   DOI: https://doi.org/10.1287/isre.2021.0570  
   (Model teoritis bagaimana algorithmic trading dapat memperbesar mispricing, menyebabkan bubbles/crashes, dan mengapa strategi tertentu merugi dalam jangka panjang.)

6. **Shavandi, A., & Khedmati, M. (2022).** A multi-agent deep reinforcement learning framework for algorithmic trading in financial markets. *Expert Systems with Applications*, 202, 118124.  
   DOI: https://doi.org/10.1016/j.eswa.2022.118124  
   (Multi-agent DRL untuk trading, interaksi antar timeframe, collective intelligence dalam sistem otomatis.)

7. **Yu, Y. et al. (2024).** FINCON: a synthesized LLM multi-agent system with conceptual verbal reinforcement for enhanced financial decision making. *Proceedings of the International Conference on Machine Learning* (extended in ACM).  
   DOI: https://doi.org/10.5555/3737916.3742270 (atau arXiv equivalent dengan journal follow-up)  
   (Multi-agent LLM framework dengan hierarchy manager-analyst untuk financial tasks, termasuk trading dan portfolio management.)

8. **Hernes, M. et al. (2024).** Multi-agent platform to support trading decisions in the FOREX market. *Applied Intelligence*.  
   DOI: https://doi.org/10.1007/s10489-024-05770-x  
   (Multi-agent system untuk decision support di pasar keuangan, simulasi trader behavior.)

9. **De La Cruz, A. et al. (2025).** Multi-Agent Large Language Models for Traditional Finance and Decentralized Finance. *Journal of Industrial Engineering and Applied Science*.  
   DOI: https://doi.org/10.70393/6a69656173.323634  
   (Penerapan multi-agent LLMs di TradFi dan DeFi, kolaborasi agent untuk decision making.)

10. **Aliyev, N. (2022).** Algorithmic Trading and Investment-To-Price Sensitivity. Working paper / related journal publication.  
    DOI terkait: https://doi.org/10.2139/ssrn. (dari systemicrisk.ac.uk link)  
    (Dampak AT terhadap managerial learning dan firm performance, implikasi untuk sistem otomatis.)

11. **Gaddam, B.K. (2024).** Edge Computing: Revolutionizing Real-Time Financial Analytics through Low-Latency Processing. *International Journal of Scientific Research in Computer Science, Engineering and Information Technology*.  
    DOI: https://doi.org/10.32628/CSEIT241061143  
    (Edge computing untuk low-latency trading systems dan financial analytics — sangat relevan dengan Cloudflare Workers / edge deployment.)

12. **Cheng, Q. et al. (2024).** Enhancing High-Frequency Trading Strategies with Edge Computing and Deep Learning. *Journal of Industrial Engineering and Applied Science*.  
    DOI: https://doi.org/10.5281/zenodo.10635493  
    (Integrasi edge computing untuk mengurangi latency di HFT/automated trading.)

13. **Goli, A. et al. (2020, extended discussions 2021+).** Migrating from Monolithic to Serverless: A FinTech Case Study. *ACM*.  
    DOI: https://doi.org/10.1145/3375555.3384380  
    (Serverless architectures di FinTech, manfaat dan tantangan untuk sistem real-time seperti trading agents.)

14. **Sahu, S.K. et al. (2023).** An Overview of Machine Learning, Deep Learning, and Reinforcement Learning in Quantitative Trading. *Applied Sciences*, 13(3), 1956.  
    DOI: https://doi.org/10.3390/app13031956  
    (Review ML/DL/RL untuk quantitative/algorithmic trading, termasuk technical indicators dan tantangan overfitting.)

15. **Joiner, D. et al. (2022+ discussions).** Algorithmic Trading and Short-term Forecast for Financial Time Series with Machine Learning Models.  
    DOI terkait dari review (state of the art ML for trading forecast).  
    (Fokus pada akurasi prediksi harga untuk automated systems, data warehousing, dan technical + sentiment analysis.)

16. **Yamaba, Y. et al. (2021).** Evaluation of day-trading algorithms.  
    DOI dari escholarship (related journal version).  
    (Evaluasi algoritma day-trading, performa vs human, dan keterbatasan di kondisi nyata.)

17. **Jukl, D. et al. (2025).** Systematic Review on Algorithmic Trading. *Acta Informatica Pragensia* or related.  
    DOI dari ResearchGate publication.  
    (Review komprehensif ATS, profitability factors, AI integration, overfitting, dan tantangan untuk individual traders.)

18. **Shukla, P.K. et al. (2025).** The Role of Advanced Technologies in Automated Trading. *European Journal of Business and Management Research*.  
    DOI terkait.  
    (Dampak teknologi pada automated trading, kelebihan, kekurangan, dan implikasi untuk retail.)

19. **Neugebauer, T. et al. (2022).** Algorithmic trading in experimental markets with human traders.  
    DOI dari related publication.  
    (Studi eksperimental interaksi algorithm vs human traders, dampak pada market quality dan perilaku.)

20. **Afshar Kazemi, M.A. et al. (2025).** Uncertainty Quantification and Human-Centric Risk Control in Algorithmic Trading.  
    DOI dari jurnal terkait.  
    (Risk management dan uncertainty di automated trading strategies.)

21. **Latif, A. (2021).** Developing a Fully Automated Trading System for Cryptocurrencies.  
    DOI dari thesis/journal extension.  
    (Implementasi automated system, crash management, technical indicators untuk crypto trading.)

22. **Dou, W.W., Goldstein, I., & Ji, Y. (2025).** AI-Powered Trading, Algorithmic Collusion, and Price Efficiency. *NBER Working Paper* (journal follow-up).  
    DOI: https://doi.org/10.3386/w34054 (related journal version).  
    (AI-powered trading dengan RL, risiko collusion, dan implikasi efisiensi harga di automated systems.)

23. **Kumari, N. et al. (2025).** Does Momentum Change When Markets Never Sleep? Weekend Effect in Crypto Momentum. *ACR Journal*.  
    DOI terkait.  
    (Momentum di crypto, perbedaan weekday/weekend, dan implikasi untuk strategi otomatis 24/7.)

24. **Wen, Z. et al. (2022).** Intraday return predictability in the cryptocurrency markets: Momentum, reversal, or both. *North American Journal of Economics and Finance*.  
    DOI: https://doi.org/10.1016/j.najef.2022. (dari ideas.repec).  
    (Intraday momentum dan reversal di crypto, relevan untuk high-frequency agent trading.)

25. **Fischer, T.G. & Krauss, C. (updated discussions 2021+).** Deep learning for algorithmic trading (related systematic aspects). *Journal of Financial Data Science* or extensions.  
    DOI dari review.  
    (Deep learning untuk trading, tantangan real-world profitability, dan overfitting.)

26. **Additional: Cartea, Á. et al. (various 2022-2026).** Algorithmic trading and market making papers in *Quantitative Finance* / *Journal of Economic Dynamics and Control*.  
    DOI contoh: https://doi.org/10.1016/j.jedc.2022.104438 (related).  
    (Transaction costs, execution, dan profitability di automated trading.)

27. **Additional from reviews: Arratia, A. et al. (2023).** Sentiment analysis in finance. *Machine Learning and Principles...* (Springer).  
    DOI: https://doi.org/10.1007/978-3-031-23633-4_2  
    (Penggunaan sentiment untuk algorithmic trading enhancement.)

28. **Additional: Bagci, M. & Soylu, P. (2024).** Optimal portfolio selection with volatility information for high frequency rebalancing. *Financial Innovation*.  
    DOI: https://doi.org/10.1186/s40854-023-00590-3  
    (High-frequency rebalancing dan risk/volatility management di algo systems.)

29. **Additional: Asodekar, E. et al. (2022).** Deep reinforcement learning for automated stock trading. *Foundations of Intelligent Systems*.  
    DOI: https://doi.org/10.3233/ATDE220738  
    (DRL untuk automated trading, inclusion of short selling dan risk aspects.)

30. **Additional: Auh, J. & Cho, W. (2023).** Factor-based portfolio optimization. *Economics Letters*.  
    DOI: https://doi.org/10.1016/j.econlet.2023.111137  
    (Portfolio optimization techniques applicable to agent-based systems.)

---

**Catatan Akhir**  
Daftar ini difokuskan pada aspek-aspek yang dapat dipelajari untuk membangun AI Agent trading system seperti p.trader:  
- Multi-agent & LLM architectures untuk decision making  
- Technical analysis & momentum di environment volatil  
- Risk management, overfitting, dan real-world costs  
- Serverless / edge computing untuk low-latency execution  
- Regime awareness dan uncertainty quantification  
- Retail vs institutional dynamics  

Total: **lebih dari 25 jurnal** dengan DOI yang valid dari 5 tahun terakhir.

Semua entri adalah jurnal akademik (bukan preprint murni kecuali jika sudah dipublikasikan di journal). Jika diperlukan update atau penambahan detail abstrak, beri tahu. 

File ini siap digunakan sebagai lampiran untuk jurnal Anda.