/**
 * Seed conversation corpus — natural Saudi Arabic.
 *
 * These are hand-written, not model-generated, so the demo reads like real
 * clinic traffic. Each script is a turn list; the seeder assigns realistic
 * timestamps, response times, patients and channels, and materialises any
 * bookings the script implies.
 */

export type Turn =
  | { from: 'patient'; text: string }
  | { from: 'agent'; text: string }
  | { from: 'staff'; text: string }
  | { from: 'system'; text: string; flagged?: boolean };

export interface ConversationScript {
  id: string;
  /** What the thread is about — used to weight channels and outcomes. */
  kind: 'booking' | 'reschedule' | 'cancel' | 'price' | 'insurance' | 'info' | 'escalation' | 'emergency';
  /** Set when the script ends in a confirmed booking. */
  booking?: {
    serviceId: string;
    doctorId: string;
    /** Days from "now"; negative for past appointments. */
    dayOffset: number;
    hour: number;
    minute?: number;
  };
  escalation?: { reason: string; detail: string };
  /** Forces the thread to be owned by a human (staff jumped in). */
  humanTakeover?: boolean;
  locale?: 'ar' | 'en';
  turns: Turn[];
}

export const CONVERSATION_SCRIPTS: ConversationScript[] = [
  // ---------------------------------------------------------- bookings
  {
    id: 'book_cleaning_evening',
    kind: 'booking',
    booking: { serviceId: 'dental_cleaning', doctorId: 'dr_reem', dayOffset: 3, hour: 16, minute: 30 },
    turns: [
      { from: 'patient', text: 'السلام عليكم' },
      { from: 'agent', text: 'وعليكم السلام ورحمة الله 🌿 معك نورة من عيادات نور الرياض، كيف أقدر أساعدك؟' },
      { from: 'patient', text: 'أبي أحجز تنظيف أسنان' },
      { from: 'agent', text: 'أبشر. عندنا مواعيد الأربعاء ٤:٣٠ العصر والخميس ٥:٠٠ العصر مع د. ريم. أيهم يناسبك؟' },
      { from: 'patient', text: 'الأربعاء زين' },
      { from: 'agent', text: 'تمام، وش الاسم الكريم؟' },
      { from: 'patient', text: 'عبدالله السبيعي' },
      { from: 'agent', text: 'ورقم جوالك عشان نرسل لك التأكيد؟' },
      { from: 'patient', text: '0551234321' },
      { from: 'agent', text: 'تم الحجز يا عبدالله ✅ تنظيف أسنان الأربعاء ٤:٣٠ العصر مع د. ريم. رقم حجزك {{ref}}. تعال قبل الموعد بـ ١٠ دقايق ومعك الهوية.' },
      { from: 'patient', text: 'يعطيك العافية' },
      { from: 'agent', text: 'الله يعافيك، نشوفك على خير 🌷' },
    ],
  },
  {
    id: 'book_whitening_night',
    kind: 'booking',
    booking: { serviceId: 'zoom_whitening', doctorId: 'dr_reem', dayOffset: 5, hour: 11 },
    turns: [
      { from: 'patient', text: 'مساء الخير، تبييض الأسنان متوفر عندكم؟' },
      { from: 'agent', text: 'مساء النور 🌿 إيه متوفر، تبييض بالليزر (زوم) ١٨٠٠ ريال، جلسة وحدة بالعيادة وتشمل قوالب متابعة للبيت.' },
      { from: 'patient', text: 'وكم تاخذ وقت؟' },
      { from: 'agent', text: 'ساعة وربع تقريبًا. ودك أشوف لك موعد؟' },
      { from: 'patient', text: 'إيه لو سمحتي، أي وقت الصبح' },
      { from: 'agent', text: 'عندي الاثنين ١١:٠٠ الصبح مع د. ريم. يناسبك؟' },
      { from: 'patient', text: 'ممتاز' },
      { from: 'agent', text: 'الاسم ورقم الجوال لو تكرمت؟' },
      { from: 'patient', text: 'ريم الغامدي 0503334455' },
      { from: 'agent', text: 'تم يا ريم ✅ تبييض زوم الاثنين ١١:٠٠ الصبح مع د. ريم العتيبي. رقم الحجز {{ref}}. يفضّل تتجنبين القهوة والشاي يوم الجلسة.' },
    ],
  },
  {
    id: 'book_botox',
    kind: 'booking',
    booking: { serviceId: 'botox_area', doctorId: 'dr_noura', dayOffset: 2, hour: 18 },
    turns: [
      { from: 'patient', text: 'هلا، عندكم بوتوكس؟' },
      { from: 'agent', text: 'هلا وغلا 🌿 إيه عندنا، بوتوكس ٩٠٠ ريال للمنطقة الوحدة مع د. نورة القحطاني أخصائية الجلدية.' },
      { from: 'patient', text: 'ابغى الجبهة' },
      { from: 'agent', text: 'تمام. متى يناسبك؟ عندي بكرة ٦:٠٠ المغرب أو الأحد ١٠:٣٠ الصبح.' },
      { from: 'patient', text: 'بكرة المغرب' },
      { from: 'agent', text: 'أبشري، الاسم ورقم الجوال؟' },
      { from: 'patient', text: 'نوف العنزي 0567778899' },
      { from: 'agent', text: 'تم يا نوف ✅ بوتوكس بكرة ٦:٠٠ المغرب مع د. نورة. رقم الحجز {{ref}}. تجنبي المسكنات المميعة قبل الجلسة بـ ٣ أيام وتعالي بوجه نظيف بدون مكياج.' },
    ],
  },
  {
    id: 'book_hydrafacial_en',
    kind: 'booking',
    locale: 'en',
    booking: { serviceId: 'hydrafacial', doctorId: 'dr_sara', dayOffset: 4, hour: 19 },
    turns: [
      { from: 'patient', text: 'Hi, do you do HydraFacial?' },
      { from: 'agent', text: 'Hi! Yes we do — HydraFacial is SAR 650 for a 60-minute session. Would you like me to check what is available?' },
      { from: 'patient', text: 'Yes please, evenings work best' },
      { from: 'agent', text: 'I have Thursday 7:00 PM with Sara Al-Harbi. Does that work?' },
      { from: 'patient', text: 'Perfect' },
      { from: 'agent', text: 'Great — could I get your name and mobile number?' },
      { from: 'patient', text: 'Layla Alsaeed, 0554443322' },
      { from: 'agent', text: 'All set, Layla ✅ HydraFacial on Thursday at 7:00 PM with Sara. Your booking reference is {{ref}}. Please arrive 10 minutes early.' },
    ],
  },
  {
    id: 'book_implant_consult',
    kind: 'booking',
    booking: { serviceId: 'dental_consult', doctorId: 'dr_khalid', dayOffset: 6, hour: 17 },
    turns: [
      { from: 'patient', text: 'مساكم الله بالخير، ابي استفسر عن الزراعة' },
      { from: 'agent', text: 'مساك الله بالنور 🌿 الزراعة تبدأ من ٤٥٠٠ ريال للزرعة الواحدة شاملة التاج، والسعر النهائي يتحدد بعد الأشعة المقطعية مع د. خالد.' },
      { from: 'patient', text: 'طيب وكم تحتاج جلسات؟' },
      { from: 'agent', text: 'يعتمد على الحالة، والدكتور يحدد الخطة بعد الكشف. أحجز لك استشارة؟ الكشف ١٥٠ ريال ويشمل الأشعة وخطة علاج مكتوبة.' },
      { from: 'patient', text: 'اوك احجزي' },
      { from: 'agent', text: 'عندي السبت ٥:٠٠ العصر مع د. خالد. يناسبك؟' },
      { from: 'patient', text: 'ايه تمام. فهد المطيري 0508887766' },
      { from: 'agent', text: 'تم يا فهد ✅ استشارة زراعة السبت ٥:٠٠ العصر مع د. خالد الدوسري. رقم الحجز {{ref}}.' },
    ],
  },
  {
    id: 'book_laser_package',
    kind: 'booking',
    booking: { serviceId: 'laser_full_body', doctorId: 'dr_sara', dayOffset: 8, hour: 14 },
    turns: [
      { from: 'patient', text: 'كم جلسة الليزر كامل الجسم؟' },
      { from: 'agent', text: 'ليزر كامل الجسم ١٢٠٠ ريال للجلسة، والجلسة ساعة ونص تقريبًا.' },
      { from: 'patient', text: 'وفيه قسم نسائي؟' },
      { from: 'agent', text: 'إيه، عندنا قسم نسائي مستقل بمدخل خاص وكادر نسائي كامل 🌷' },
      { from: 'patient', text: 'حلو، ابي احجز' },
      { from: 'agent', text: 'أبشري. عندي الثلاثاء ٢:٠٠ الظهر مع الأستاذة سارة. يناسبك؟' },
      { from: 'patient', text: 'ايه' },
      { from: 'agent', text: 'الاسم ورقم الجوال؟' },
      { from: 'patient', text: 'منيرة الدوسري ٠٥٥٢٢٢١١٠٠' },
      { from: 'agent', text: 'تم يا منيرة ✅ ليزر كامل الجسم الثلاثاء ٢:٠٠ الظهر. رقم الحجز {{ref}}. احلقي المنطقة بالشفرة قبل الجلسة بـ ١٢ ساعة ولا تستخدمين الشمع قبلها بأسبوعين.' },
    ],
  },
  {
    id: 'book_filling',
    kind: 'booking',
    booking: { serviceId: 'composite_filling', doctorId: 'dr_reem', dayOffset: 1, hour: 10 },
    turns: [
      { from: 'patient', text: 'هلا، محتاج حشوة لسن قدامي' },
      { from: 'agent', text: 'هلا فيك 🌿 الحشوة التجميلية ٤٠٠ ريال للسن الواحد، والجلسة ٤٥ دقيقة.' },
      { from: 'patient', text: 'متى اقرب موعد؟' },
      { from: 'agent', text: 'بكرة ١٠:٠٠ الصبح مع د. ريم، أو بعد بكرة ١٢:٠٠ الظهر.' },
      { from: 'patient', text: 'بكرة' },
      { from: 'agent', text: 'الاسم ورقم الجوال؟' },
      { from: 'patient', text: 'سلطان القحطاني 0533221100' },
      { from: 'agent', text: 'تم يا سلطان ✅ حشوة تجميلية بكرة ١٠:٠٠ الصبح مع د. ريم. رقم الحجز {{ref}}.' },
    ],
  },
  {
    id: 'book_aligners',
    kind: 'booking',
    booking: { serviceId: 'clear_aligners', doctorId: 'dr_reem', dayOffset: 9, hour: 12 },
    turns: [
      { from: 'patient', text: 'التقويم الشفاف كم؟' },
      { from: 'agent', text: 'التقويم الشفاف من ١٢٠٠٠ إلى ١٨٠٠٠ ريال للحالة كاملة حسب عدد القوالب، ويشمل المسح الرقمي والمتابعة كل ٦ أسابيع.' },
      { from: 'patient', text: 'وفيه تقسيط؟' },
      { from: 'agent', text: 'إيه فيه تقسيط عبر تابي وتمارا على ٤ دفعات بدون فوائد.' },
      { from: 'patient', text: 'زين ابي اجي اشوف' },
      { from: 'agent', text: 'أبشر. عندي الأربعاء الجاي ١٢:٠٠ الظهر مع د. ريم لجلسة المسح والتقييم. يناسبك؟' },
      { from: 'patient', text: 'ايه. تركي الحربي 0501112233' },
      { from: 'agent', text: 'تم يا تركي ✅ جلسة تقويم شفاف الأربعاء ١٢:٠٠ الظهر مع د. ريم. رقم الحجز {{ref}}.' },
    ],
  },
  {
    id: 'book_prp',
    kind: 'booking',
    booking: { serviceId: 'prp_hair', doctorId: 'dr_noura', dayOffset: 7, hour: 11, minute: 30 },
    turns: [
      { from: 'patient', text: 'عندكم بلازما للشعر؟' },
      { from: 'agent', text: 'إيه عندنا، بلازما PRP ١١٠٠ ريال للجلسة مع د. نورة.' },
      { from: 'patient', text: 'طيب احجزي لي' },
      { from: 'agent', text: 'أبشر. الأحد الجاي ١١:٣٠ الصبح يناسبك؟' },
      { from: 'patient', text: 'ايه تمام' },
      { from: 'agent', text: 'الاسم ورقم الجوال؟' },
      { from: 'patient', text: 'ماجد العتيبي 0544445566' },
      { from: 'agent', text: 'تم يا ماجد ✅ بلازما للشعر الأحد ١١:٣٠ الصبح مع د. نورة. رقم الحجز {{ref}}. تجنّب المسكنات المميعة قبل الجلسة بـ ٣ أيام.' },
    ],
  },
  {
    id: 'book_kids_checkup',
    kind: 'booking',
    booking: { serviceId: 'dental_consult', doctorId: 'dr_reem', dayOffset: 10, hour: 10, minute: 30 },
    turns: [
      { from: 'patient', text: 'تستقبلون أطفال؟ بنتي عمرها ٧ سنين' },
      { from: 'agent', text: 'إيه نستقبل الأطفال لخدمات الأسنان مع ولي الأمر 🌷 الكشف ١٥٠ ريال.' },
      { from: 'patient', text: 'زين، ابي موعد الصبح' },
      { from: 'agent', text: 'عندي الخميس ١٠:٣٠ الصبح مع د. ريم. يناسبك؟' },
      { from: 'patient', text: 'ايه. أم عبدالعزيز - 0509998877' },
      { from: 'agent', text: 'تم ✅ كشف أسنان الخميس ١٠:٣٠ الصبح مع د. ريم. رقم الحجز {{ref}}. ياليت تجيبين الهوية وبطاقة التأمين إذا عندكم.' },
    ],
  },

  // ------------------------------------------------------- reschedules
  {
    id: 'reschedule_simple',
    kind: 'reschedule',
    turns: [
      { from: 'patient', text: 'السلام عليكم، ابي اأجل موعدي' },
      { from: 'agent', text: 'وعليكم السلام 🌿 أكيد، عطني رقم الحجز وأشوف لك المتاح.' },
      { from: 'patient', text: 'NR-4TQ82M' },
      { from: 'agent', text: 'لقيته، تنظيف أسنان الثلاثاء ٥:٠٠ العصر. متى يناسبك بدال عنه؟' },
      { from: 'patient', text: 'الخميس نفس الوقت إذا يمدي' },
      { from: 'agent', text: 'تم التأجيل ✅ صار الخميس ٥:٠٠ العصر مع د. ريم. رقم حجزك الجديد NR-9PW3KD — القديم انلغى.' },
      { from: 'patient', text: 'تسلمين' },
    ],
  },
  {
    id: 'reschedule_late',
    kind: 'reschedule',
    turns: [
      { from: 'patient', text: 'ما اقدر اجي اليوم صار عندي ظرف' },
      { from: 'agent', text: 'ولا يهمك 🌷 عطني رقم الحجز وأأجله لك.' },
      { from: 'patient', text: 'ما احفظه، جوالي 0551234321' },
      { from: 'agent', text: 'لقيت موعدك: حشوة تجميلية اليوم ٧:٠٠ المغرب. أأجله لك متى؟' },
      { from: 'patient', text: 'الاسبوع الجاي أي يوم' },
      { from: 'agent', text: 'عندي الأحد ٦:٣٠ المغرب أو الاثنين ١١:٠٠ الصبح.' },
      { from: 'patient', text: 'الاحد' },
      { from: 'agent', text: 'تم ✅ الأحد ٦:٣٠ المغرب. رقم الحجز الجديد NR-2XM7QF. ملاحظة بس: التأجيل قبل الموعد بأقل من ٤ ساعات يُحتسب عليه ١٠٠ ريال على الموعد الجاي.' },
      { from: 'patient', text: 'ماشي مشكور' },
    ],
  },
  {
    id: 'reschedule_doctor_change',
    kind: 'reschedule',
    turns: [
      { from: 'patient', text: 'ابي اغير موعدي واكون مع دكتورة بنت' },
      { from: 'agent', text: 'أبشري 🌷 عندنا د. ريم العتيبي لطب الأسنان التجميلي ود. نورة القحطاني للجلدية. عطيني رقم الحجز.' },
      { from: 'patient', text: 'NR-6KD41P' },
      { from: 'agent', text: 'تمام، الموعد كان كشف أسنان. عندي مع د. ريم الثلاثاء ١٢:٠٠ الظهر أو الأربعاء ٩:٣٠ الصبح.' },
      { from: 'patient', text: 'الثلاثاء' },
      { from: 'agent', text: 'تم ✅ الثلاثاء ١٢:٠٠ الظهر مع د. ريم. رقم الحجز الجديد NR-8HB25R.' },
    ],
  },

  // --------------------------------------------------------- cancels
  {
    id: 'cancel_travel',
    kind: 'cancel',
    turns: [
      { from: 'patient', text: 'ابي الغي موعدي بكرة، مسافر' },
      { from: 'agent', text: 'ولا يهمك، عطني رقم الحجز.' },
      { from: 'patient', text: 'NR-3QW85N' },
      { from: 'agent', text: 'تم الإلغاء ✅ سلامتك، وإذا رجعت خبرني وأحجز لك من جديد.' },
      { from: 'patient', text: 'يعطيك العافية' },
    ],
  },
  {
    id: 'cancel_and_rebook',
    kind: 'cancel',
    turns: [
      { from: 'patient', text: 'الغي موعد الليزر حقي' },
      { from: 'agent', text: 'أبشري، رقم الحجز لو سمحتي؟' },
      { from: 'patient', text: 'NR-7VN26L' },
      { from: 'agent', text: 'تم الإلغاء ✅ تبين أحجز لك وقت ثاني؟' },
      { from: 'patient', text: 'لا الحين، بكلمكم بعدين' },
      { from: 'agent', text: 'تمام، حياك أي وقت 🌷' },
    ],
  },

  // ----------------------------------------------------- price queries
  {
    id: 'price_veneers',
    kind: 'price',
    turns: [
      { from: 'patient', text: 'كم سعر ابتسامة هوليوود عندكم؟' },
      { from: 'agent', text: 'الفينير يبدأ من ٢٢٠٠ ريال للسن الواحد، والعدد يتحدد بعد جلسة تصميم الابتسامة مع د. ريم.' },
      { from: 'patient', text: 'وكم سن عادة؟' },
      { from: 'agent', text: 'يختلف من حالة لحالة والدكتورة هي اللي تحدد بعد الكشف. أحجز لك جلسة تصميم ابتسامة؟' },
      { from: 'patient', text: 'خليني افكر' },
      { from: 'agent', text: 'أبشر، حياك أي وقت 🌿' },
    ],
  },
  {
    id: 'price_multi',
    kind: 'price',
    turns: [
      { from: 'patient', text: 'ابغى اعرف اسعار التنظيف والتبييض' },
      { from: 'agent', text: 'التنظيف والتلميع ٣٥٠ ريال، والتبييض بالليزر ١٨٠٠ ريال 🌿' },
      { from: 'patient', text: 'والكشف؟' },
      { from: 'agent', text: 'الكشف والاستشارة ١٥٠ ريال وتشمل الأشعة إذا احتجناها وخطة علاج مكتوبة.' },
      { from: 'patient', text: 'مشكورة' },
    ],
  },
  {
    id: 'price_filler',
    kind: 'price',
    turns: [
      { from: 'patient', text: 'فيلر الشفايف كم؟' },
      { from: 'agent', text: 'فيلر الشفايف ١٦٠٠ ريال للعبوة الوحدة، ويشمل المخدر الموضعي.' },
      { from: 'patient', text: 'وكم يستمر؟' },
      { from: 'agent', text: 'هذي نقطة أحب د. نورة ترد عليك فيها بدقة أثناء الاستشارة. أحجز لك موعد؟' },
      { from: 'patient', text: 'اوك بكلمكم' },
    ],
  },
  {
    id: 'price_laser_small',
    kind: 'price',
    turns: [
      { from: 'patient', text: 'ليزر الوجه بس كم؟' },
      { from: 'agent', text: 'المنطقة الصغيرة زي الوجه ٣٠٠ ريال للجلسة 🌿' },
      { from: 'patient', text: 'تمام شكرا' },
    ],
  },
  {
    id: 'price_installments',
    kind: 'price',
    turns: [
      { from: 'patient', text: 'فيه تقسيط على التقويم؟' },
      { from: 'agent', text: 'إيه فيه تقسيط عبر تابي وتمارا على ٤ دفعات بدون فوائد للعلاجات فوق ١٠٠٠ ريال.' },
      { from: 'patient', text: 'حلو' },
    ],
  },

  // -------------------------------------------------- insurance queries
  {
    id: 'insurance_bupa',
    kind: 'insurance',
    turns: [
      { from: 'patient', text: 'تقبلون بوبا؟' },
      { from: 'agent', text: 'إيه نقبل بوبا العربية بالفوترة المباشرة 🌿 الفئات A و B، بس العلاجات التجميلية غير مغطاة.' },
      { from: 'patient', text: 'يعني التبييض ما يدخل؟' },
      { from: 'agent', text: 'صح، التبييض والفينير والبوتوكس والليزر كلها تجميلية وتُدفع نقدًا أو بالشبكة.' },
      { from: 'patient', text: 'طيب التنظيف؟' },
      { from: 'agent', text: 'التنظيف علاجي وعادة يغطيه التأمين. جيب بطاقتك وإحنا نتحقق لك قبل الجلسة.' },
    ],
  },
  {
    id: 'insurance_tawuniya_approval',
    kind: 'insurance',
    turns: [
      { from: 'patient', text: 'عندي تعاونية، احتاج موافقة لعلاج العصب؟' },
      { from: 'agent', text: 'إيه، علاج العصب والزراعة يحتاجون موافقة مسبقة مع التعاونية. نرسل الطلب ونرد عليك خلال يوم عمل.' },
      { from: 'patient', text: 'وش المطلوب مني؟' },
      { from: 'agent', text: 'بس الهوية وبطاقة التأمين، وإحنا نتكفل بالباقي 🌷' },
    ],
  },
  {
    id: 'insurance_not_accepted',
    kind: 'insurance',
    turns: [
      { from: 'patient', text: 'عندي تأمين زيارة، ينفع؟' },
      { from: 'agent', text: 'للأسف تأمين الزيارة والتأمين السياحي ما نقبلهم. تقدر تدفع نقدًا أو بالشبكة وفيه تقسيط عبر تابي وتمارا.' },
      { from: 'patient', text: 'اها تمام' },
    ],
  },
  {
    id: 'insurance_medgulf',
    kind: 'insurance',
    turns: [
      { from: 'patient', text: 'ميدغلف مقبول؟' },
      { from: 'agent', text: 'إيه ميدغلف مقبول بالفوترة المباشرة، للأسنان فقط بدون تغطية للتجميل 🌿' },
    ],
  },

  // ------------------------------------------------------ info queries
  {
    id: 'info_hours',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'وش دوامكم اليوم؟' },
      { from: 'agent', text: 'دوامنا من الأحد إلى الخميس ٩ الصباح إلى ٩ بالليل مع استراحة من ١ إلى ٤ العصر، والسبت من ١٢ الظهر إلى ٩ بالليل. الجمعة إجازة 🌿' },
    ],
  },
  {
    id: 'info_location',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'وين موقعكم؟' },
      { from: 'agent', text: 'إحنا في حي الصحافة على طريق الأمير تركي بن عبدالعزيز الأول، مقابل بوليفارد الصحافة، نفس مبنى صيدلية النهدي الدور الثاني. أرسل لك اللوكيشن؟' },
      { from: 'patient', text: 'ايه ارسليه' },
      { from: 'agent', text: 'تفضل: https://maps.google.com/?q=24.8075,46.6390 — وفيه مواقف مجانية في قبو المبنى B1، الدخول من البوابة الخلفية.' },
      { from: 'patient', text: 'يعطيك العافية' },
    ],
  },
  {
    id: 'info_parking',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'فيه مواقف عندكم؟' },
      { from: 'agent', text: 'إيه فيه مواقف مجانية للمراجعين في قبو المبنى B1، والدخول من البوابة الخلفية 🚗' },
    ],
  },
  {
    id: 'info_female_doctor',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'فيه دكتورة بنت للاسنان؟' },
      { from: 'agent', text: 'إيه، د. ريم العتيبي استشارية طب أسنان تجميلي وتصميم ابتسامة، خبرة ١٢ سنة 🌷' },
      { from: 'patient', text: 'حلو، وللبشرة؟' },
      { from: 'agent', text: 'د. نورة القحطاني أخصائية جلدية وتجميل، والأستاذة سارة الحربي لليزر والعناية بالبشرة.' },
    ],
  },
  {
    id: 'info_walkin',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'اقدر اجي بدون موعد؟' },
      { from: 'agent', text: 'نستقبل بدون موعد لكن حسب توفر الدكتور وقد تنتظر شوي. الأفضل أحجز لك موعد وتجي على راحتك. ودك أشوف المتاح؟' },
      { from: 'patient', text: 'لا بس اسأل' },
      { from: 'agent', text: 'أبشر، حياك 🌿' },
    ],
  },
  {
    id: 'info_first_visit',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'وش احتاج اجيب معي اول مرة؟' },
      { from: 'agent', text: 'جيب الهوية أو الإقامة وبطاقة التأمين إذا عندك، وأي أشعة أو تقارير سابقة إذا متوفرة. وتعال قبل الموعد بـ ١٠ دقايق 🌿' },
    ],
  },
  {
    id: 'info_english_staff',
    kind: 'info',
    locale: 'en',
    turns: [
      { from: 'patient', text: 'Do your doctors speak English?' },
      { from: 'agent', text: 'Yes — Dr. Reem, Dr. Khalid and Dr. Noura all speak English, and Dr. Noura also speaks French.' },
      { from: 'patient', text: 'Great, and what are your hours?' },
      { from: 'agent', text: 'Sunday to Thursday 9 AM–9 PM with a break from 1–4 PM, and Saturday 12 PM–9 PM. We are closed on Friday.' },
    ],
  },
  {
    id: 'info_offers',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'فيه عروض؟' },
      { from: 'agent', text: 'العروض تتغير كل شهر وتنزل على حسابنا @noor.riyadh.clinics. أقدر أوصلك بالإدارة لو تبي تعرف عرض معين 🌿' },
      { from: 'patient', text: 'لا خلاص شكرا' },
    ],
  },
  {
    id: 'info_post_whitening',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'سويت تبييض امس، وش الممنوع؟' },
      { from: 'agent', text: 'أول ٤٨ ساعة ابتعد عن القهوة والشاي والكولا والصلصات الملونة والتدخين. الحساسية الخفيفة طبيعية وتروح خلال يومين 🌿' },
      { from: 'patient', text: 'والمويا الباردة؟' },
      { from: 'agent', text: 'لو حسيت بحساسية من البارد خفف منها اليومين هذي. وإذا استمر الانزعاج كلمنا على رقم العيادة ونرتب لك متابعة.' },
    ],
  },
  {
    id: 'info_cancellation_policy',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'اذا الغيت متأخر فيه غرامة؟' },
      { from: 'agent', text: 'الإلغاء أو التأجيل مجاني إذا كان قبل الموعد بـ ٤ ساعات على الأقل، وبعدها يُحتسب ١٠٠ ريال على الموعد القادم.' },
      { from: 'patient', text: 'واذا ما حضرت اصلا؟' },
      { from: 'agent', text: 'عدم الحضور بدون إشعار يُحتسب عليه ١٥٠ ريال يُضاف على الموعد الجاي، فياليت تخبرنا لو ما تقدر تجي 🌷' },
    ],
  },
  {
    id: 'info_records_request',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'ابي نسخة من ملفي الطبي' },
      { from: 'agent', text: 'أكيد، حقك تطلب نسخة من ملفك أو تطلب حذف بياناتك. رفعت طلبك للإدارة وبيتواصلون معك خلال يوم عمل 🌿' },
    ],
  },

  // -------------------------------------------------------- escalations
  {
    id: 'escalate_symptom_toothache',
    kind: 'escalation',
    escalation: { reason: 'symptom_description', detail: 'Clinical tripwire: ar.symptom_generic, ar.diagnosis_request' },
    turns: [
      { from: 'patient', text: 'عندي وجع في ضرس العقل وفيه تورم بسيط، وش السبب؟' },
      { from: 'system', text: 'هذي النقطة أحب الدكتور نفسه يرد عليك فيها عشان تكون الإجابة دقيقة. حوّلت محادثتك للفريق وبيتواصلون معك بأقرب وقت خلال الدوام 🌷 وإذا تبي، أقدر أحجز لك موعد استشارة الحين.', flagged: true },
      { from: 'patient', text: 'طيب احجزي لي' },
      { from: 'staff', text: 'هلا أبو محمد، معك أحمد من العيادة. رتبت لك موعد عاجل مع د. خالد بكرة ٤:٣٠ العصر وبنشوف الوضع. لو زاد الألم الليلة كلمنا على طول.' },
      { from: 'patient', text: 'الله يعطيك العافية' },
    ],
    humanTakeover: true,
  },
  {
    id: 'escalate_suitability',
    kind: 'escalation',
    escalation: { reason: 'treatment_suitability', detail: 'Clinical tripwire: ar.suitability — patient asked if filler is safe while pregnant' },
    turns: [
      { from: 'patient', text: 'انا حامل بالشهر الخامس، الفيلر مناسب لي؟' },
      { from: 'system', text: 'هذي النقطة أحب الدكتور نفسه يرد عليك فيها عشان تكون الإجابة دقيقة. حوّلت محادثتك للفريق وبيتواصلون معك بأقرب وقت خلال الدوام 🌷', flagged: true },
      { from: 'staff', text: 'هلا أم سارة، معك هند من العيادة. د. نورة تفضل تشوفك بالعيادة قبل أي إجراء. أرتب لك موعد استشارة؟' },
      { from: 'patient', text: 'ايه لو سمحتي' },
    ],
    humanTakeover: true,
  },
  {
    id: 'escalate_price_negotiation',
    kind: 'escalation',
    escalation: { reason: 'unpublished_price', detail: 'price.not_in_published_list — patient asked for a custom package quote' },
    turns: [
      { from: 'patient', text: 'ابي عرض خاص لو سويت ٨ عدسات فينير + تبييض، كم تنزلون لي؟' },
      { from: 'system', text: 'هذي النقطة أحب الدكتور نفسه يرد عليك فيها عشان تكون الإجابة دقيقة. حوّلت محادثتك للفريق وبيتواصلون معك بأقرب وقت خلال الدوام 🌷 وإذا تبي، أقدر أحجز لك موعد استشارة الحين.', flagged: true },
      { from: 'patient', text: 'اوك انتظر' },
    ],
  },
  {
    id: 'escalate_medical_advice_meds',
    kind: 'escalation',
    escalation: { reason: 'medical_advice', detail: 'Clinical tripwire: ar.medication — patient asked which antibiotic to take' },
    turns: [
      { from: 'patient', text: 'اي مضاد حيوي اخذ قبل الزراعة؟' },
      { from: 'system', text: 'هذي النقطة أحب الدكتور نفسه يرد عليك فيها عشان تكون الإجابة دقيقة. حوّلت محادثتك للفريق وبيتواصلون معك بأقرب وقت خلال الدوام 🌷', flagged: true },
      { from: 'staff', text: 'هلا، معك أحمد من العيادة. أي دواء قبل الإجراء يوصفه لك د. خالد نفسه حسب حالتك، ولا تاخذ شي من نفسك. موعدك باقي عليه يومين وبنراجع معك كل شي.' },
      { from: 'patient', text: 'تمام مشكور' },
    ],
    humanTakeover: true,
  },
  {
    id: 'escalate_complaint',
    kind: 'escalation',
    escalation: { reason: 'agent_requested', detail: 'Patient complaint about waiting time — asked for a manager' },
    turns: [
      { from: 'patient', text: 'انتظرت ٤٥ دقيقة امس بدون سبب، ابي اكلم المسؤول' },
      { from: 'system', text: 'هذي النقطة أحب الدكتور نفسه يرد عليك فيها عشان تكون الإجابة دقيقة. حوّلت محادثتك للفريق وبيتواصلون معك بأقرب وقت خلال الدوام 🌷', flagged: true },
      { from: 'staff', text: 'هلا أستاذ نايف، معك هند مديرة خدمة العملاء. أعتذر لك عن التأخير أمس، وسجلت ملاحظتك. أرتب لك موعدك الجاي بأول الفترة عشان ما تنتظر.' },
      { from: 'patient', text: 'اقدرلك هذا' },
    ],
    humanTakeover: true,
  },
  {
    id: 'escalate_outcome_question',
    kind: 'escalation',
    escalation: { reason: 'treatment_suitability', detail: 'Clinical tripwire: ar.suitability — asked for a guaranteed result' },
    turns: [
      { from: 'patient', text: 'الليزر بيشيل الشعر نهائي عندي؟ شعري خشن' },
      { from: 'system', text: 'هذي النقطة أحب الدكتور نفسه يرد عليك فيها عشان تكون الإجابة دقيقة. حوّلت محادثتك للفريق وبيتواصلون معك بأقرب وقت خلال الدوام 🌷 وإذا تبي، أقدر أحجز لك موعد استشارة الحين.', flagged: true },
    ],
  },

  // --------------------------------------------------------- emergency
  {
    id: 'emergency_severe_pain',
    kind: 'emergency',
    escalation: { reason: 'emergency_language', detail: 'Emergency tripwire: ar.severe_pain, ar.unbearable' },
    turns: [
      { from: 'patient', text: 'عندي ألم شديد ما أقدر أتحمله من ضرسي والوجه بدأ ينتفخ' },
      { from: 'system', text: '⚠️ إذا الوضع طارئ اتصل على الإسعاف 997 فورًا أو توجه لأقرب طوارئ. وللحالات المستعجلة عندنا كلّم خط العيادة مباشرة +966112345600. سلامتك أهم شي، لا تنتظر رد الرسائل.\nأقرب طوارئ: مستشفى الملك فهد التخصصي - قسم الطوارئ، طريق الملك عبدالعزيز', flagged: true },
      { from: 'staff', text: 'كلمتك الحين على جوالك ما رديت. توجه لأقرب طوارئ فورًا وخبرنا، وإذا وصلت العيادة بكرة د. خالد بيشوفك أول شي.' },
    ],
    humanTakeover: true,
  },
  {
    id: 'emergency_bleeding',
    kind: 'emergency',
    escalation: { reason: 'emergency_language', detail: 'Emergency tripwire: ar.bleeding' },
    turns: [
      { from: 'patient', text: 'خلعت ضرس امس والحين فيه نزيف ما يوقف' },
      { from: 'system', text: '⚠️ إذا الوضع طارئ اتصل على الإسعاف 997 فورًا أو توجه لأقرب طوارئ. وللحالات المستعجلة عندنا كلّم خط العيادة مباشرة +966112345600. سلامتك أهم شي، لا تنتظر رد الرسائل.\nأقرب طوارئ: مستشفى الملك فهد التخصصي - قسم الطوارئ، طريق الملك عبدالعزيز', flagged: true },
      { from: 'staff', text: 'معك أحمد من العيادة، كلمنا على الخط المستعجل الحين +966112345600 وبنوجهك خطوة بخطوة.' },
    ],
    humanTakeover: true,
  },
  {
    id: 'emergency_english_chest',
    kind: 'emergency',
    locale: 'en',
    escalation: { reason: 'emergency_language', detail: 'Emergency tripwire: en.chest_pain' },
    turns: [
      { from: 'patient', text: 'I have chest pain and feel dizzy after the injection yesterday' },
      { from: 'system', text: '⚠️ If this is an emergency, call 997 for an ambulance right away or go to the nearest emergency room. For urgent clinic cases call us directly on +966112345600. Please do not wait for a reply here.', flagged: true },
      { from: 'staff', text: 'This is Hind from the clinic. Please call 997 now or go to the nearest ER. We have flagged your file and Dr. Noura will follow up as soon as you are safe.' },
    ],
    humanTakeover: true,
  },

  // ----------------------------------------- extra day-to-day traffic
  {
    id: 'info_running_late',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'بتأخر ١٠ دقايق على موعدي' },
      { from: 'agent', text: 'ولا يهمك، خبرت الاستقبال 🌿 بس ملاحظة: لو التأخير زاد عن ١٥ دقيقة قد نحتاج نأجل الموعد حسب جدول الدكتور.' },
      { from: 'patient', text: 'تمام جاي الحين' },
    ],
  },
  {
    id: 'info_confirm_tomorrow',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'موعدي بكرة صح؟' },
      { from: 'agent', text: 'إيه صحيح ✅ تنظيف أسنان بكرة ٥:٠٠ العصر مع د. ريم، رقم الحجز NR-5RT93K. تعال قبل بـ ١٠ دقايق.' },
      { from: 'patient', text: 'تمام' },
    ],
  },
  {
    id: 'info_deposit',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'لازم ادفع عربون للزراعة؟' },
      { from: 'agent', text: 'إيه، المواعيد الجراحية والتجميلية تحتاج عربون ٥٠٠ ريال ويُخصم من قيمة العلاج 🌿' },
      { from: 'patient', text: 'كيف ادفعه؟' },
      { from: 'agent', text: 'تقدر تدفعه بالعيادة قبل الموعد بمدى أو الشبكة، أو نرسل لك رابط دفع. أي وحدة أسهل لك؟' },
      { from: 'patient', text: 'رابط' },
      { from: 'agent', text: 'أبشر، الإدارة بترسله لك على نفس الرقم خلال شوي 🌷' },
    ],
  },
  {
    id: 'info_home_visit',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'تسوون زيارات منزلية؟' },
      { from: 'agent', text: 'لا للأسف، كل خدماتنا داخل العيادة فقط 🌿' },
    ],
  },
  {
    id: 'info_payment_methods',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'تقبلون ابل باي؟' },
      { from: 'agent', text: 'إيه نقبل مدى وفيزا وماستر وأبل باي والكاش، وفيه تقسيط عبر تابي وتمارا 🌿' },
    ],
  },
  {
    id: 'info_break_time',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'انتم مفتوحين الحين؟ الساعة ٢ الظهر' },
      { from: 'agent', text: 'حاليًا إحنا في استراحة الظهر من ١ إلى ٤ العصر. نفتح الساعة ٤ ونستمر لين ٩ بالليل 🌿 ودك أحجز لك موعد بعد الاستراحة؟' },
      { from: 'patient', text: 'لا بكرة ان شاء الله' },
    ],
  },
  {
    id: 'book_deep_cleanse_late',
    kind: 'booking',
    booking: { serviceId: 'deep_cleanse', doctorId: 'dr_sara', dayOffset: 12, hour: 19, minute: 30 },
    turns: [
      { from: 'patient', text: 'تنظيف بشرة عميق متوفر؟' },
      { from: 'agent', text: 'إيه، تنظيف البشرة العميق ٥٠٠ ريال والجلسة ساعة 🌿' },
      { from: 'patient', text: 'ابي بعد الدوام حقي، ٧ ونص' },
      { from: 'agent', text: 'عندي الأحد الجاي ٧:٣٠ المغرب مع الأستاذة سارة. يناسبك؟' },
      { from: 'patient', text: 'ايه ممتاز' },
      { from: 'agent', text: 'الاسم ورقم الجوال؟' },
      { from: 'patient', text: 'هيا الشمري 0556667788' },
      { from: 'agent', text: 'تم يا هيا ✅ تنظيف بشرة عميق الأحد ٧:٣٠ المغرب. رقم الحجز {{ref}}.' },
    ],
  },
  {
    id: 'book_meso',
    kind: 'booking',
    booking: { serviceId: 'meso_skin', doctorId: 'dr_noura', dayOffset: 11, hour: 17 },
    turns: [
      { from: 'patient', text: 'الميزوثيرابي للبشرة كم؟' },
      { from: 'agent', text: 'ميزوثيرابي البشرة ٨٠٠ ريال للجلسة مع د. نورة 🌿' },
      { from: 'patient', text: 'احجزي لي اقرب موعد' },
      { from: 'agent', text: 'عندي السبت ٥:٠٠ العصر. يناسبك؟' },
      { from: 'patient', text: 'ايه. دانة العنقري 0502223344' },
      { from: 'agent', text: 'تم يا دانة ✅ ميزوثيرابي السبت ٥:٠٠ العصر مع د. نورة. رقم الحجز {{ref}}.' },
    ],
  },
  {
    id: 'book_extraction',
    kind: 'booking',
    booking: { serviceId: 'extraction', doctorId: 'dr_khalid', dayOffset: 2, hour: 19 },
    turns: [
      { from: 'patient', text: 'ابي اخلع ضرس' },
      { from: 'agent', text: 'أبشر، الخلع يبدأ من ٣٠٠ ريال والجلسة ٤٠ دقيقة مع د. خالد.' },
      { from: 'patient', text: 'متى اقرب موعد؟' },
      { from: 'agent', text: 'بكرة ٧:٠٠ المغرب أو بعد بكرة ٦:٠٠ المغرب.' },
      { from: 'patient', text: 'بكرة' },
      { from: 'agent', text: 'الاسم ورقم الجوال؟' },
      { from: 'patient', text: 'بندر العتيبي 0505556677' },
      { from: 'agent', text: 'تم يا بندر ✅ خلع ضرس بكرة ٧:٠٠ المغرب مع د. خالد. رقم الحجز {{ref}}. تعال وأنت فاطر ولا تجي على معدة فاضية.' },
    ],
  },
  {
    id: 'book_root_canal_en',
    kind: 'booking',
    locale: 'en',
    booking: { serviceId: 'root_canal', doctorId: 'dr_khalid', dayOffset: 5, hour: 18 },
    turns: [
      { from: 'patient', text: 'My dentist abroad said I need a root canal. Do you do those?' },
      { from: 'agent', text: 'Yes we do — root canal treatment starts from SAR 1200 depending on the tooth, with Dr. Khalid Al-Dosari.' },
      { from: 'patient', text: 'Could I come this week? Evenings only please' },
      { from: 'agent', text: 'I have Thursday at 6:00 PM with Dr. Khalid. Would that suit you?' },
      { from: 'patient', text: 'Yes. Omar Bakr, 0559998877' },
      { from: 'agent', text: 'Booked, Omar ✅ Root canal on Thursday at 6:00 PM with Dr. Khalid. Your reference is {{ref}}. Please have a light meal beforehand.' },
    ],
  },
  {
    id: 'info_saturday_hours',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'مفتوحين السبت؟' },
      { from: 'agent', text: 'إيه، السبت من ١٢ الظهر إلى ٩ بالليل 🌿 الجمعة بس إجازة.' },
      { from: 'patient', text: 'زين' },
    ],
  },
  {
    id: 'info_womens_section',
    kind: 'info',
    turns: [
      { from: 'patient', text: 'القسم النسائي منفصل تماما؟' },
      { from: 'agent', text: 'إيه، قسم نسائي مستقل بمدخل خاص وكادر نسائي كامل لخدمات التجميل والليزر 🌷' },
      { from: 'patient', text: 'الحمدلله، شكرا' },
    ],
  },
  {
    id: 'book_cleaning_night_owl',
    kind: 'booking',
    booking: { serviceId: 'dental_cleaning', doctorId: 'dr_reem', dayOffset: 13, hour: 12 },
    turns: [
      { from: 'patient', text: 'مساء الخير' },
      { from: 'agent', text: 'مساء النور 🌿 معك نورة من عيادات نور الرياض، كيف أقدر أساعدك؟' },
      { from: 'patient', text: 'ابي تنظيف اسنان الاسبوع الجاي' },
      { from: 'agent', text: 'أبشر. عندي الاثنين ١٢:٠٠ الظهر أو الثلاثاء ١٠:٠٠ الصبح مع د. ريم.' },
      { from: 'patient', text: 'الاثنين' },
      { from: 'agent', text: 'الاسم ورقم الجوال؟' },
      { from: 'patient', text: 'عمر الزهراني 0507778899' },
      { from: 'agent', text: 'تم يا عمر ✅ تنظيف أسنان الاثنين ١٢:٠٠ الظهر مع د. ريم. رقم الحجز {{ref}}.' },
    ],
  },
];
