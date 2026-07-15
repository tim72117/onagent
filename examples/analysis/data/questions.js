// Snapshot of the real response from examples/analysis/backend's
// /analysis/1/getAnalysisQuestions (the mock backend's actual Postgres-
// backed, XML-driven question data — see questions.go) — dumped to a static
// file so Menu.vue no longer needs a live backend to load real-looking
// question data. 216 questions from a real teacher-training internship
// survey. Re-fetch and overwrite this file if the mock backend's seed data
// ever changes.
export const questions = [
    {
        "name": "p2q1",
        "title": "您是否已閱讀以上一至四點的內容，並同意繼續填寫問卷？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "我已閱讀完畢並同意繼續填寫"
            }
        ]
    },
    {
        "name": "p3q1c1",
        "title": "請選擇您所具備的師資生資格是什麼類科？（可複選）-幼兒園",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q1c2",
        "title": "請選擇您所具備的師資生資格是什麼類科？（可複選）-國民小學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q1c3",
        "title": "請選擇您所具備的師資生資格是什麼類科？（可複選）-中等學校",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q1c4",
        "title": "請選擇您所具備的師資生資格是什麼類科？（可複選）-特殊教育",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q2",
        "title": "您預計參與實習的師資類科(組)為何？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "暫不打算參與實習"
            },
            {
                "value": "2",
                "title": "幼兒園"
            },
            {
                "value": "3",
                "title": "國民小學"
            },
            {
                "value": "4",
                "title": "中等學校"
            },
            {
                "value": "5",
                "title": "特殊教育學校（班）"
            }
        ]
    },
    {
        "name": "p3s3",
        "title": "您預計參與實習的師資類科(組)為何？-中等學校-請問您預計實習的教育階段是？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "國民中學"
            },
            {
                "value": "2",
                "title": "高級中等學校"
            }
        ]
    },
    {
        "name": "p3s7",
        "title": "您預計參與實習的師資類科(組)為何？-中等學校-請問您預計實習的教育階段是？-國民中學-請問您預計實習的領域是？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "語文領域-國語文"
            },
            {
                "value": "2",
                "title": "語文領域-英語文"
            },
            {
                "value": "3",
                "title": "語文領域-第二外國語文"
            },
            {
                "value": "4",
                "title": "語文領域-本土語文閩南語文"
            },
            {
                "value": "5",
                "title": "語文領域-本土語文客家語文"
            },
            {
                "value": "6",
                "title": "語文領域-本土語文原住民族語文"
            },
            {
                "value": "7",
                "title": "語文領域-新住民語文"
            },
            {
                "value": "8",
                "title": "數學領域-數學"
            },
            {
                "value": "9",
                "title": "社會領域-歷史"
            },
            {
                "value": "10",
                "title": "社會領域-地理"
            },
            {
                "value": "11",
                "title": "社會領域-公民與社會"
            },
            {
                "value": "12",
                "title": "自然科學領域-物理"
            },
            {
                "value": "13",
                "title": "自然科學領域-化學"
            },
            {
                "value": "14",
                "title": "自然科學領域-生物"
            },
            {
                "value": "15",
                "title": "自然科學領域-地球科學"
            },
            {
                "value": "16",
                "title": "藝術領域-音樂"
            },
            {
                "value": "17",
                "title": "藝術領域-視覺藝術或藝術領域美術科"
            },
            {
                "value": "18",
                "title": "藝術領域-表演藝術"
            },
            {
                "value": "19",
                "title": "綜合活動領域-家政"
            },
            {
                "value": "20",
                "title": "綜合活動領域-輔導"
            },
            {
                "value": "21",
                "title": "綜合活動領域-童軍"
            },
            {
                "value": "22",
                "title": "科技領域-生活科技"
            },
            {
                "value": "23",
                "title": "科技領域-資訊科技"
            },
            {
                "value": "24",
                "title": "健康與體育領域-體育"
            },
            {
                "value": "25",
                "title": "健康與體育領域-健康教育或健康與護理科"
            },
            {
                "value": "26",
                "title": "輔導教師"
            }
        ]
    },
    {
        "name": "p3s4",
        "title": "您預計參與實習的師資類科(組)為何？-中等學校-請問您預計實習的教育階段是？-高級中等學校-請問您預計實習的領域是？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "普通學科"
            },
            {
                "value": "2",
                "title": "職業群科"
            }
        ]
    },
    {
        "name": "p3s6",
        "title": "您預計參與實習的師資類科(組)為何？-中等學校-請問您預計實習的教育階段是？-高級中等學校-請問您預計實習的領域是？-普通學科-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "語文領域-國語文"
            },
            {
                "value": "2",
                "title": "語文領域-英語文"
            },
            {
                "value": "3",
                "title": "語文領域-第二外國語文"
            },
            {
                "value": "4",
                "title": "語文領域-本土語文閩南語文"
            },
            {
                "value": "5",
                "title": "語文領域-本土語文客家語文"
            },
            {
                "value": "6",
                "title": "語文領域-本土語文原住民族語文"
            },
            {
                "value": "7",
                "title": "語文領域-新住民語文"
            },
            {
                "value": "8",
                "title": "數學領域-數學"
            },
            {
                "value": "9",
                "title": "社會領域-歷史"
            },
            {
                "value": "10",
                "title": "社會領域-地理"
            },
            {
                "value": "11",
                "title": "社會領域-公民與社會"
            },
            {
                "value": "12",
                "title": "自然科學領域-物理"
            },
            {
                "value": "13",
                "title": "自然科學領域-化學"
            },
            {
                "value": "14",
                "title": "自然科學領域-生物"
            },
            {
                "value": "15",
                "title": "自然科學領域-地球科學"
            },
            {
                "value": "16",
                "title": "藝術領域-音樂"
            },
            {
                "value": "17",
                "title": "藝術領域-視覺藝術或藝術領域美術科"
            },
            {
                "value": "18",
                "title": "藝術領域藝術生活科-表演藝術"
            },
            {
                "value": "19",
                "title": "藝術領域藝術生活科-音樂應用"
            },
            {
                "value": "20",
                "title": "藝術領域藝術生活科-視覺應用"
            },
            {
                "value": "21",
                "title": "綜合活動領域-家政"
            },
            {
                "value": "22",
                "title": "綜合活動領域生命教育科"
            },
            {
                "value": "23",
                "title": "綜合活動領域生涯規劃科"
            },
            {
                "value": "24",
                "title": "綜合活動領域法律與生活科"
            },
            {
                "value": "25",
                "title": "綜合活動領域環境科學概論科"
            },
            {
                "value": "26",
                "title": "科技領域-生活科技"
            },
            {
                "value": "27",
                "title": "科技領域-資訊科技"
            },
            {
                "value": "28",
                "title": "健康與體育領域-體育"
            },
            {
                "value": "29",
                "title": "健康與體育領域-健康教育或健康與護理科"
            },
            {
                "value": "30",
                "title": "全民國防教育科"
            },
            {
                "value": "31",
                "title": "輔導教師"
            }
        ]
    },
    {
        "name": "p3s5",
        "title": "您預計參與實習的師資類科(組)為何？-中等學校-請問您預計實習的教育階段是？-高級中等學校-請問您預計實習的領域是？-職業群科-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "機械群"
            },
            {
                "value": "2",
                "title": "動力機械群"
            },
            {
                "value": "3",
                "title": "電機與電子群-資電"
            },
            {
                "value": "4",
                "title": "電機與電子群-電機"
            },
            {
                "value": "5",
                "title": "化工群"
            },
            {
                "value": "6",
                "title": "土木與建築群-土木"
            },
            {
                "value": "7",
                "title": "土木與建築群-建築"
            },
            {
                "value": "8",
                "title": "商業與管理群-商管"
            },
            {
                "value": "9",
                "title": "商業與管理群-資管"
            },
            {
                "value": "10",
                "title": "外語群-英文"
            },
            {
                "value": "11",
                "title": "外語群-日文"
            },
            {
                "value": "12",
                "title": "設計群-平面、媒體設計"
            },
            {
                "value": "13",
                "title": "設計群-立體造形"
            },
            {
                "value": "14",
                "title": "設計群-室內設計"
            },
            {
                "value": "15",
                "title": "農業群-農業生產與休閒生態"
            },
            {
                "value": "16",
                "title": "農業群-動物飼養及保健"
            },
            {
                "value": "17",
                "title": "食品群"
            },
            {
                "value": "18",
                "title": "家政群"
            },
            {
                "value": "19",
                "title": "餐旅群-觀光"
            },
            {
                "value": "20",
                "title": "餐旅群-餐飲"
            },
            {
                "value": "21",
                "title": "水產群-漁業"
            },
            {
                "value": "22",
                "title": "水產群-水產養殖"
            },
            {
                "value": "23",
                "title": "海事群-輪機技術"
            },
            {
                "value": "24",
                "title": "海事群-航海技術"
            },
            {
                "value": "25",
                "title": "藝術群-表演藝術"
            },
            {
                "value": "26",
                "title": "藝術群-視覺藝術"
            },
            {
                "value": "27",
                "title": "藝術群-音像藝術"
            }
        ]
    },
    {
        "name": "p3s2",
        "title": "您預計參與實習的師資類科(組)為何？-特殊教育學校（班）-您預計實習的類別：",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "身心障礙"
            },
            {
                "value": "2",
                "title": "資賦優異"
            }
        ]
    },
    {
        "name": "p3s1",
        "title": "您預計參與實習的師資類科(組)為何？-特殊教育學校（班）-您預計實習的教育階段別：",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "學前"
            },
            {
                "value": "2",
                "title": "國民小學"
            },
            {
                "value": "3",
                "title": "中等學校"
            }
        ]
    },
    {
        "name": "p3q3",
        "title": "您曾經領過(卓越)師資培育獎學金嗎？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "否"
            },
            {
                "value": "2",
                "title": "是"
            }
        ]
    },
    {
        "name": "p3q4c1",
        "title": "請問（卓越）師資培育獎學金對您的幫助為何？（可複選，請勾選所有符合者）□降低經濟負擔□培養利他精神與社會關懷□激發教育熱忱□精進教育專業知能與實踐□其他-降低經濟負擔",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q4c2",
        "title": "請問（卓越）師資培育獎學金對您的幫助為何？（可複選，請勾選所有符合者）□降低經濟負擔□培養利他精神與社會關懷□激發教育熱忱□精進教育專業知能與實踐□其他-培養利他精神與社會關懷",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q4c3",
        "title": "請問（卓越）師資培育獎學金對您的幫助為何？（可複選，請勾選所有符合者）□降低經濟負擔□培養利他精神與社會關懷□激發教育熱忱□精進教育專業知能與實踐□其他-激發教育熱忱",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q4c4",
        "title": "請問（卓越）師資培育獎學金對您的幫助為何？（可複選，請勾選所有符合者）□降低經濟負擔□培養利他精神與社會關懷□激發教育熱忱□精進教育專業知能與實踐□其他-精進教育專業知能與實踐",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q4c5",
        "title": "請問（卓越）師資培育獎學金對您的幫助為何？（可複選，請勾選所有符合者）□降低經濟負擔□培養利他精神與社會關懷□激發教育熱忱□精進教育專業知能與實踐□其他-其他",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q5",
        "title": "大學入學後，您是否曾報名參與公費生甄選？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "否"
            },
            {
                "value": "2",
                "title": "是"
            }
        ]
    },
    {
        "name": "p3q6",
        "title": "您是否同意公費生的甄選制度公平合理？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q7sc1",
        "title": "公費生甄選制度不太公平合理，下列原因您同意的程度如何？-過度關係取向，較有利特定個人或團體",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q7sc2",
        "title": "公費生甄選制度不太公平合理，下列原因您同意的程度如何？-特定身分（如族群、地區）保障名額過多",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q7sc3",
        "title": "公費生甄選制度不太公平合理，下列原因您同意的程度如何？-報名條件不合理",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q7sc4",
        "title": "公費生甄選制度不太公平合理，下列原因您同意的程度如何？-甄選過程不透明",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q7sc5",
        "title": "公費生甄選制度不太公平合理，下列原因您同意的程度如何？-甄選標準不合理",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q8",
        "title": "您是否為公費生？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "否"
            },
            {
                "value": "2",
                "title": "曾經是，但現在不是"
            },
            {
                "value": "3",
                "title": "是"
            }
        ]
    },
    {
        "name": "p3q9",
        "title": "請問您取得公費生資格管道是：",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "大學申請入學"
            },
            {
                "value": "2",
                "title": "大學指考分發"
            },
            {
                "value": "3",
                "title": "碩博士班甄選入學"
            },
            {
                "value": "4",
                "title": "碩博士班考試入學"
            },
            {
                "value": "5",
                "title": "入學後通過校內甄選（含大學與碩博士班）"
            },
            {
                "value": "6",
                "title": "離島與原住民師資保送資格"
            }
        ]
    },
    {
        "name": "p3q10",
        "title": "請問您瞭解公費生的權利與義務嗎？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不瞭解"
            },
            {
                "value": "2",
                "title": "不瞭解"
            },
            {
                "value": "3",
                "title": "瞭解"
            },
            {
                "value": "4",
                "title": "非常瞭解"
            }
        ]
    },
    {
        "name": "p3q11",
        "title": "請問您想要成為公費生最主要是誰的主張？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "自我選擇"
            },
            {
                "value": "2",
                "title": "家人期待"
            },
            {
                "value": "3",
                "title": "師長鼓勵"
            },
            {
                "value": "4",
                "title": "其他"
            }
        ]
    },
    {
        "name": "p3q12",
        "title": "請問您想要成為公費生最主要之動機或理由為何？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "改善或解決經濟問題"
            },
            {
                "value": "2",
                "title": "就業保障"
            },
            {
                "value": "3",
                "title": "自我挑戰"
            },
            {
                "value": "4",
                "title": "返鄉服務"
            },
            {
                "value": "5",
                "title": "其他"
            }
        ]
    },
    {
        "name": "p3q13",
        "title": "在申請公費生資格時，請問你知道畢業後要服務的縣市或學校嗎?",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "都不知道"
            },
            {
                "value": "2",
                "title": "只知道要服務的縣市"
            },
            {
                "value": "3",
                "title": "知道要去哪一間學校（或單位）服務"
            }
        ]
    },
    {
        "name": "p3q14",
        "title": "在獲得公費生資格時是否有規定你要修習的學科／領域／群科／次專長數？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "沒有"
            },
            {
                "value": "2",
                "title": "規定一個"
            },
            {
                "value": "3",
                "title": "規定兩個"
            },
            {
                "value": "4",
                "title": "規定三個"
            },
            {
                "value": "5",
                "title": "規定四個(含)以上"
            }
        ]
    },
    {
        "name": "p3q15sc1",
        "title": "下列對於公費生制度的說明，您同意程度如何？-能夠選拔具優秀能力的師資生從事教職",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc2",
        "title": "下列對於公費生制度的說明，您同意程度如何？-能夠選拔具教育與服務熱忱的師資生從事教職",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc3",
        "title": "下列對於公費生制度的說明，您同意程度如何？-能夠保障偏遠或特殊地區學校獲得充裕穩定師資",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc4",
        "title": "下列對於公費生制度的說明，您同意程度如何？-能讓師資生無經濟壓力，專心學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc5",
        "title": "下列對於公費生制度的說明，您同意程度如何？-師資培育大學能提供公費生良好的學習輔導與支持",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc6",
        "title": "下列對於公費生制度的說明，您同意程度如何？-公費生額外課程修習的要求過多",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc7",
        "title": "下列對於公費生制度的說明，您同意程度如何？-公費生畢業後要求服務六年的年限過長",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc8",
        "title": "下列對於公費生制度的說明，您同意程度如何？-公費生畢業後服務地點的規定合理",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc9",
        "title": "下列對於公費生制度的說明，您同意程度如何？-成為公費生，我覺得課業學習的壓力很大",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc10",
        "title": "下列對於公費生制度的說明，您同意程度如何？-達成公費生各項要求，時程很趕、時間壓力很大",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc11",
        "title": "下列對於公費生制度的說明，您同意程度如何？-公費生的身份讓我和同儕關係較緊張",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q15sc12",
        "title": "下列對於公費生制度的說明，您同意程度如何？-我曾想放棄公費生資格",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p3q16c1",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-未達公費生標準而被淘汰",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q16c2",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-課業負擔過重",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q16c3",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-不滿意服務學校地點",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q16c4",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-不滿意規定的服務年限",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q16c5",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-對任教科目沒有興趣",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q16c6",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-生涯規劃改變，不想被教職綁住",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q16c7",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-想憑自己能力考上正式教職",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q16c8",
        "title": "請問您喪失公費生資格最主要的原因為何？（可複選，請勾選所有符合者）-其他",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q17",
        "title": "您是否參加過任何的英語能力檢定？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "否"
            },
            {
                "value": "2",
                "title": "是"
            }
        ]
    },
    {
        "name": "p3q18c1",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-全民英檢",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s33",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-全民英檢-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3q18c2",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-雅思國際英語測驗",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s32",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-雅思國際英語測驗-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "3(含)以上未滿4"
            },
            {
                "value": "2",
                "title": "4(含)以上未滿5.5"
            },
            {
                "value": "3",
                "title": "5.5(含)以上未滿7"
            },
            {
                "value": "4",
                "title": "7(含)以上未滿8"
            },
            {
                "value": "5",
                "title": "8(含)以上"
            }
        ]
    },
    {
        "name": "p3q18c3",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-傳統多益",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s31",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-傳統多益-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "350-549分"
            },
            {
                "value": "2",
                "title": "550-749分"
            },
            {
                "value": "3",
                "title": "750-879分"
            },
            {
                "value": "4",
                "title": "880-949 分"
            },
            {
                "value": "5",
                "title": "950（含）分以上"
            }
        ]
    },
    {
        "name": "p3q18c4",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-新版多益（聽、讀）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s30",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-新版多益（聽、讀）-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "225-549分"
            },
            {
                "value": "2",
                "title": "550-784分"
            },
            {
                "value": "3",
                "title": "785-944分"
            },
            {
                "value": "4",
                "title": "945（含）分以上"
            }
        ]
    },
    {
        "name": "p3q18c5",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-新版多益口說",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s29",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-新版多益口說-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "90-119分 (Level4)"
            },
            {
                "value": "2",
                "title": "120-159分 (Level5-6)"
            },
            {
                "value": "3",
                "title": "160-199分 (Level7)"
            },
            {
                "value": "4",
                "title": "200分 (Level8)"
            }
        ]
    },
    {
        "name": "p3q18c6",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-新版托福",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s28",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-新版托福-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "42-71分"
            },
            {
                "value": "2",
                "title": "72-94分"
            },
            {
                "value": "3",
                "title": "95（含）分 以上"
            }
        ]
    },
    {
        "name": "p3q18c7",
        "title": "您參加過哪些的英語能力檢定？在該能力檢定中最佳的成績為何？（可複選）-其他",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q19c1",
        "title": "您是否參加過以下語言檢定？您在該能力檢定中最佳的成績為何？（可複選）（各族語、成績計算）-否",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3q19c2",
        "title": "您是否參加過以下語言檢定？您在該能力檢定中最佳的成績為何？（可複選）（各族語、成績計算）-閩南語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s26",
        "title": "您是否參加過以下語言檢定？您在該能力檢定中最佳的成績為何？（可複選）（各族語、成績計算）-閩南語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "基礎級"
            },
            {
                "value": "2",
                "title": "初級"
            },
            {
                "value": "3",
                "title": "中級"
            },
            {
                "value": "4",
                "title": "中高級"
            },
            {
                "value": "5",
                "title": "高級"
            },
            {
                "value": "6",
                "title": "專業級"
            }
        ]
    },
    {
        "name": "p3q19c3",
        "title": "您是否參加過以下語言檢定？您在該能力檢定中最佳的成績為何？（可複選）（各族語、成績計算）-客家語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s25",
        "title": "您是否參加過以下語言檢定？您在該能力檢定中最佳的成績為何？（可複選）（各族語、成績計算）-客家語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級暨中高級"
            },
            {
                "value": "3",
                "title": "高級"
            }
        ]
    },
    {
        "name": "p3q19c4",
        "title": "您是否參加過以下語言檢定？您在該能力檢定中最佳的成績為何？（可複選）（各族語、成績計算）-原住民語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s8c1",
        "title": "您參加過哪一族語別？（可複選）-阿美語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s24",
        "title": "您參加過哪一族語別？（可複選）-阿美語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c2",
        "title": "您參加過哪一族語別？（可複選）-泰雅語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s23",
        "title": "您參加過哪一族語別？（可複選）-泰雅語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c3",
        "title": "您參加過哪一族語別？（可複選）-賽夏語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s22",
        "title": "您參加過哪一族語別？（可複選）-賽夏語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c4",
        "title": "您參加過哪一族語別？（可複選）-邵語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s21",
        "title": "您參加過哪一族語別？（可複選）-邵語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c5",
        "title": "您參加過哪一族語別？（可複選）-賽德克語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s20",
        "title": "您參加過哪一族語別？（可複選）-賽德克語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c6",
        "title": "您參加過哪一族語別？（可複選）-布農語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s19",
        "title": "您參加過哪一族語別？（可複選）-布農語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c7",
        "title": "您參加過哪一族語別？（可複選）-排灣語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s18",
        "title": "您參加過哪一族語別？（可複選）-排灣語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c8",
        "title": "您參加過哪一族語別？（可複選）-魯凱語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s17",
        "title": "您參加過哪一族語別？（可複選）-魯凱語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c9",
        "title": "您參加過哪一族語別？（可複選）-太魯閣語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s16",
        "title": "您參加過哪一族語別？（可複選）-太魯閣語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c10",
        "title": "您參加過哪一族語別？（可複選）-噶瑪蘭語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s15",
        "title": "您參加過哪一族語別？（可複選）-噶瑪蘭語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c11",
        "title": "您參加過哪一族語別？（可複選）-鄒語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s14",
        "title": "您參加過哪一族語別？（可複選）-鄒語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c12",
        "title": "您參加過哪一族語別？（可複選）-卑南語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s13",
        "title": "您參加過哪一族語別？（可複選）-卑南語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c13",
        "title": "您參加過哪一族語別？（可複選）-雅美語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s12",
        "title": "您參加過哪一族語別？（可複選）-雅美語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c14",
        "title": "您參加過哪一族語別？（可複選）-撒奇萊雅語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s11",
        "title": "您參加過哪一族語別？（可複選）-撒奇萊雅語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c15",
        "title": "您參加過哪一族語別？（可複選）-卡那卡那富語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s10",
        "title": "您參加過哪一族語別？（可複選）-卡那卡那富語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p3s8c16",
        "title": "您參加過哪一族語別？（可複選）-拉阿魯哇語",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p3s9",
        "title": "您參加過哪一族語別？（可複選）-拉阿魯哇語-",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "初級"
            },
            {
                "value": "2",
                "title": "中級"
            },
            {
                "value": "3",
                "title": "中高級"
            },
            {
                "value": "4",
                "title": "高級"
            },
            {
                "value": "5",
                "title": "優級"
            }
        ]
    },
    {
        "name": "p4q1sc1",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-覺得課程很實用",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q1sc2",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-積極參與討論、發問",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q1sc3",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-以團隊或社群協作的方式學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q1sc4",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-至幼兒園或中小學現場進行實地學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q1sc5",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-對課程不感興趣",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q1sc6",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-作業缺交或應付了事",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q1sc7",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-蹺課或缺課",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q1sc8",
        "title": "整體而言，當您修習師資培育課程時，下列修課情形發生的頻率為何？-上課不專心（如：做自己的事、放空）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q2sc1",
        "title": "整體而言，當您修習師資培育課程期間，參與下列事項的頻率為何？-課外參與教育相關的演講、研討會或工作坊",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q2sc2",
        "title": "整體而言，當您修習師資培育課程期間，參與下列事項的頻率為何？-教學實務相關競賽或優良作品徵選活動",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q2sc3",
        "title": "整體而言，當您修習師資培育課程期間，參與下列事項的頻率為何？-閱讀課外教育相關的書籍或資料",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q2sc4",
        "title": "整體而言，當您修習師資培育課程期間，參與下列事項的頻率為何？-關心並討論教育政策與時事的發展",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q2sc5",
        "title": "整體而言，當您修習師資培育課程期間，參與下列事項的頻率為何？-參加教育服務活動、中小學補救教學、課後輔導、課後留園或短期教育營隊（如：實踐史懷哲精神教育服務計畫）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q2sc6",
        "title": "整體而言，當您修習師資培育課程期間，參與下列事項的頻率為何？-兼家教、到補習班教書、伴讀或幼兒陪玩",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q2sc7",
        "title": "整體而言，當您修習師資培育課程期間，參與下列事項的頻率為何？-擔任代理、代課或鐘點老師",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc1",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-透過講述法進行教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc2",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-引導學生探究實作與問題解決",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc3",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-引導學生自主學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc4",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-將課程與實務或應用結合",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc5",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-實施跨領域／跨學科的教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc6",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-運用資訊科技或數位教材進行教學（含學習平台）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc7",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-進行分組合作學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc8",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-進行實例研討與分析",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc9",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-實地參訪、見習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc10",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-運用多元評量",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q3sc11",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略的頻率為何？-將教師資格考試或教師甄試考題融入教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "極少或沒有"
            },
            {
                "value": "2",
                "title": "偶爾"
            },
            {
                "value": "3",
                "title": "有時"
            },
            {
                "value": "4",
                "title": "經常"
            }
        ]
    },
    {
        "name": "p4q4sc1",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-透過講述法進行教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc2",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-引導學生探究實作與問題解決",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc3",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-引導學生自主學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc4",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-將課程與實務或應用結合",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc5",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-實施跨領域／跨學科的教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc6",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-運用資訊科技或數位教材進行教學（含學習平台）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc7",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-進行分組合作學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc8",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-進行實例研討與分析",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc9",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-實地參訪、見習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc10",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-運用多元評量",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q4sc11",
        "title": "當您修習師資培育課程時，教授們使用下列教學策略對您學習的幫助程度為何？-將教師資格考試或教師甄試考題融入教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒幫助"
            },
            {
                "value": "2",
                "title": "沒幫助"
            },
            {
                "value": "3",
                "title": "有幫助"
            },
            {
                "value": "4",
                "title": "非常有幫助"
            },
            {
                "value": "5",
                "title": "沒有使用"
            }
        ]
    },
    {
        "name": "p4q5sc1",
        "title": "整體來說，您認為貴校師資培育課程讓您在下列項目上的收穫成長如何？-讓我覺察並反思自己的性別平等意識",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒收穫"
            },
            {
                "value": "2",
                "title": "沒收穫"
            },
            {
                "value": "3",
                "title": "有收穫"
            },
            {
                "value": "4",
                "title": "非常有收穫"
            }
        ]
    },
    {
        "name": "p4q5sc2",
        "title": "整體來說，您認為貴校師資培育課程讓您在下列項目上的收穫成長如何？-讓我能夠同理不同性別觀點者的立場與主張",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒收穫"
            },
            {
                "value": "2",
                "title": "沒收穫"
            },
            {
                "value": "3",
                "title": "有收穫"
            },
            {
                "value": "4",
                "title": "非常有收穫"
            }
        ]
    },
    {
        "name": "p4q5sc3",
        "title": "整體來說，您認為貴校師資培育課程讓您在下列項目上的收穫成長如何？-讓我學會將性別平等教育妥適地融入課程教學中",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒收穫"
            },
            {
                "value": "2",
                "title": "沒收穫"
            },
            {
                "value": "3",
                "title": "有收穫"
            },
            {
                "value": "4",
                "title": "非常有收穫"
            }
        ]
    },
    {
        "name": "p4q5sc4",
        "title": "整體來說，您認為貴校師資培育課程讓您在下列項目上的收穫成長如何？-我有信心將來任教時能妥善處理性別平等教育議題",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒收穫"
            },
            {
                "value": "2",
                "title": "沒收穫"
            },
            {
                "value": "3",
                "title": "有收穫"
            },
            {
                "value": "4",
                "title": "非常有收穫"
            }
        ]
    },
    {
        "name": "p4q6",
        "title": "您是否同意貴校師資培育課程的整體課堂氛圍對多元性別學生是友善的？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            },
            {
                "value": "5",
                "title": "不清楚，尚無法判斷"
            }
        ]
    },
    {
        "name": "p4q7",
        "title": "修習師資培育課程，您平均每門課（2學分）每週課後花多少時間學習（含讀書、做作業、小組討論）？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "未滿半小時"
            },
            {
                "value": "2",
                "title": "半小時（含）以上-未滿1小時"
            },
            {
                "value": "3",
                "title": "1小時（含）以上-未滿2小時"
            },
            {
                "value": "4",
                "title": "2小時（含）以上-未滿3小時"
            },
            {
                "value": "5",
                "title": "3小時（含）以上-未滿4小時"
            },
            {
                "value": "6",
                "title": "4小時（含）以上"
            }
        ]
    },
    {
        "name": "p4q8",
        "title": "相較於修習本科系課程，您修習師資培育課程的投入程度如何？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "無法進行兩者比較，本科系課程即是以教育課程為主"
            },
            {
                "value": "2",
                "title": "低很多"
            },
            {
                "value": "3",
                "title": "比較低"
            },
            {
                "value": "4",
                "title": "差不多"
            },
            {
                "value": "5",
                "title": "比較高"
            },
            {
                "value": "6",
                "title": "高很多"
            }
        ]
    },
    {
        "name": "p4q9sc1",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-師培單位提供的課程選擇不多，能選的很少",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q9sc2",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-課程說明清楚，有助於我選課決定",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q9sc3",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-我選課時，會考量開課時間能否配合",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q9sc4",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-我選課時，會考量課程是否對通過教師資格考試有用",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q9sc5",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-我選課時，會考量授課教師教學的品質",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q9sc6",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-我選課時，會考量課業負擔不要太重",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q9sc7",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-我選課時，會考量給分較鬆，以免降低學業平均",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q9sc8",
        "title": "下列關於師資培育課程選課的描述，您同意的程度如何？-我選課時，常修不到自己要修的課",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不同意"
            },
            {
                "value": "2",
                "title": "不同意"
            },
            {
                "value": "3",
                "title": "同意"
            },
            {
                "value": "4",
                "title": "非常同意"
            }
        ]
    },
    {
        "name": "p4q10c1",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學語文領域教材教法-國語教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c2",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學語文領域教材教法-英語教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c3",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學語文領域教材教法-本土語文閩南語文教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c4",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學語文領域教材教法-本土語文客家語文教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c5",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學語文領域教材教法-本土語文原住民族語文教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c6",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學語文領域教材教法-新住民語文教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c7",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學數學領域教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c8",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學社會領域教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c9",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學自然科學領域教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c10",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學科技領域資訊教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c11",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學藝術領域教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c12",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學健康與體育領域教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c13",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學綜合活動領域教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c14",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學生活課程教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c15",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學跨領域教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p4q10c16",
        "title": "您有修過下列哪些教材教法課程？（可複選，請勾選所有符合者）-國民小學雙語教材教法",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "是"
            },
            {
                "value": "0",
                "title": "否"
            }
        ]
    },
    {
        "name": "p5q1sc1",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我了解有關教育目的和價值的主要理論或思想，以建構自身的教育理念與信念",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc2",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能覺察社會環境對學生學習影響，以利教育機會均等",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc3",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我了解我國教育政策、法規及學校實務，以作為教育實踐的基礎",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc4",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能了解並尊重學生身心發展、社經及文化背景的差異，以作為教學與輔導的依據",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc5",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能了解並運用學習原理，以符合學生個別的學習需求與發展。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc6",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我了解特殊需求學生的特質及鑑定歷程，以提供適切的教育與支持。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc7",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能依據課程綱要/大綱、課程理論及教學原理，以規劃素養導向課程、教學及評量",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc8",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能依據課程綱要/大綱、課程理論及教學原理，以協同發展跨領域/群科/科目課程、教學及評量",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc9",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我具備任教領域/群科/科目所需的專門知識與學科教學知能，以進行教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc10",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能掌握社會變遷趨勢與議題，以融入課程與教學",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc11",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能應用多元教學策略、教學媒材及學習科技，以促進學生有效學習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc12",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能根據多元評量結果調整課程與教學，以提升學生學習成效。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc13",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我了解如何應用正向支持原理，共創安全、友善及對話的班級與學習環境，以養成學生良好品格及有效學習。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc14",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我了解如何應用輔導原理與技巧進行學生輔導，以促進適性發展。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc15",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能認同教師專業倫理，以維護學生福祉。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc16",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能透過教育實踐關懷弱勢學生，以體現教師專業角色。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p5q1sc17",
        "title": "修畢師資職前教育課程，下列敘述符合您情況的程度如何？-我能透過教育實踐與省思，以發展個人溝通、團隊合作、問題解決及持續專業成長的意願與能力。",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不符合"
            },
            {
                "value": "2",
                "title": "不符合"
            },
            {
                "value": "3",
                "title": "符合"
            },
            {
                "value": "4",
                "title": "非常符合"
            }
        ]
    },
    {
        "name": "p6q1sc1",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-參與教師資格考試",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc2",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-參與教育實習",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc3",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-報考教師甄試（公費生免答）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc4",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-進修教育相關高階學位（如：碩、博士）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc5",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-進修非教育相關高階學位（如：碩、博士）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc6",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-擔任代理代課老師或教保員",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc7",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-規劃加註其他專長或加科登記",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc8",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-擔任教育行政人員（含約聘僱）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc9",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-開設或經營補習班／幼兒園／安親班／教育相關個人工作室或公司",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc10",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-受雇於其他文教相關產業（如補習班、出版社、人力資源管理工作等）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc11",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-投入實驗教育、另類教育等教育創新工作",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q1sc12",
        "title": "修畢師資培育課程，您對以下事項的意願如何？-找非教育領域相關工作",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q2",
        "title": "請問您將來是否有意願在偏鄉（含離島）學校長期任教？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p6q3",
        "title": "請問您目前有多少信心以英語進行有效教學？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒信心"
            },
            {
                "value": "2",
                "title": "沒信心"
            },
            {
                "value": "3",
                "title": "有信心"
            },
            {
                "value": "4",
                "title": "非常有信心"
            }
        ]
    },
    {
        "name": "p6q4",
        "title": "請問您以英語進行教學的意願為何？",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常沒意願"
            },
            {
                "value": "2",
                "title": "沒意願"
            },
            {
                "value": "3",
                "title": "有意願"
            },
            {
                "value": "4",
                "title": "非常有意願"
            }
        ]
    },
    {
        "name": "p7q1sc1",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-師資培育政策及修課規定（含課程地圖）等資訊的說明",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc2",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-協助我了解師資培育單位的教育目標",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc3",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-教育相關演講、活動、參訪見習的辦理",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc4",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-師資生修課期間參與教學實習的諮詢或輔導",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc5",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-教師資格考試、教師甄試的諮詢或輔導",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc6",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-與實務人員（如：幼兒園、中小學教師等）交流學習的機會",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc7",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-教學現場的教育實踐機會（如：辦理學校營隊、補救教學及教保活動）",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc8",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-整體課程安排及活動設計",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc9",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-師資生在教師職場的競爭力",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc10",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-師資生在非教育領域的職場競爭力",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    },
    {
        "name": "p7q1sc11",
        "title": "對於下列貴校師資培育單位（院、處、中心或系所）的敘述，您的滿意度為何？-整體專業度與服務品質",
        "choosed": false,
        "answers": [
            {
                "value": "1",
                "title": "非常不滿意"
            },
            {
                "value": "2",
                "title": "不滿意"
            },
            {
                "value": "3",
                "title": "滿意"
            },
            {
                "value": "4",
                "title": "非常滿意"
            }
        ]
    }
]
